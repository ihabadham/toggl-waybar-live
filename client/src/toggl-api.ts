import {
  type NormalizedEntry,
  normalizedEntrySchema,
  rfc3339Schema,
} from "@toggl-waybar-live/shared";

import type { DayWindow } from "./day-window.js";

export interface QuotaStatus {
  remaining: number | null;
  resetsInSeconds: number | null;
}

export type ApiResult<T> =
  | { ok: true; data: T; quota: QuotaStatus }
  | {
      ok: false;
      error: "authentication_failed" | "quota_exhausted" | "request_failed";
      permanent: boolean;
      quota: QuotaStatus;
      status: number | null;
    };

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function quotaFrom(response: Response): QuotaStatus {
  const parseHeader = (name: string): number | null => {
    const value = response.headers.get(name);
    if (value === null || !/^\d+$/.test(value)) {
      return null;
    }
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  };
  return {
    remaining: parseHeader("x-toggl-quota-remaining"),
    resetsInSeconds: parseHeader("x-toggl-quota-resets-in"),
  };
}

function id(record: UnknownRecord, current: string, legacy: string): unknown {
  return record[current] ?? record[legacy];
}

function normalizeEntry(value: unknown): NormalizedEntry {
  if (!isRecord(value)) {
    throw new Error("invalid entry");
  }
  const start = rfc3339Schema.parse(value.start);
  const stop = value.stop === null ? null : rfc3339Schema.parse(value.stop);
  const rawDuration = value.duration;
  const durationSeconds =
    stop === null
      ? null
      : typeof rawDuration === "number" && Number.isFinite(rawDuration) && rawDuration >= 0
        ? rawDuration
        : Math.max(0, (Date.parse(stop) - Date.parse(start)) / 1_000);

  return normalizedEntrySchema.parse({
    id: value.id,
    workspaceId: id(value, "workspace_id", "wid"),
    userId: id(value, "user_id", "uid"),
    projectId: id(value, "project_id", "pid") ?? null,
    projectName: typeof value.project_name === "string" ? value.project_name : null,
    description: typeof value.description === "string" ? value.description : "",
    start,
    stop,
    durationSeconds,
  });
}

function unwrapData(value: unknown): unknown {
  return isRecord(value) && "data" in value ? value.data : value;
}

export class TogglApi {
  private readonly authorization: string;

  constructor(
    apiToken: string,
    private readonly fetcher: Fetcher = fetch,
    private readonly baseUrl = "https://api.track.toggl.com",
  ) {
    this.authorization = `Basic ${Buffer.from(`${apiToken}:api_token`, "utf8").toString("base64")}`;
  }

  async fetchToday(window: DayWindow): Promise<ApiResult<NormalizedEntry[]>> {
    const url = new URL("/api/v9/me/time_entries", this.baseUrl);
    url.searchParams.set("start_date", window.start);
    url.searchParams.set("end_date", window.end);
    url.searchParams.set("meta", "true");
    return this.request(url, (value) => {
      const data = unwrapData(value);
      if (!Array.isArray(data)) {
        throw new Error("invalid list");
      }
      return data.map(normalizeEntry);
    });
  }

  async fetchCurrent(): Promise<ApiResult<NormalizedEntry | null>> {
    const url = new URL("/api/v9/me/time_entries/current", this.baseUrl);
    return this.request(url, (value) => {
      const data = unwrapData(value);
      return data === null ? null : normalizeEntry(data);
    });
  }

  private async request<T>(url: URL, parse: (value: unknown) => T): Promise<ApiResult<T>> {
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: "GET",
        headers: { authorization: this.authorization, accept: "application/json" },
      });
    } catch {
      return {
        ok: false,
        error: "request_failed",
        permanent: false,
        quota: { remaining: null, resetsInSeconds: null },
        status: null,
      };
    }

    const quota = quotaFrom(response);
    if (!response.ok) {
      const authenticationFailure = response.status === 401 || response.status === 403;
      return {
        ok: false,
        error:
          response.status === 402
            ? "quota_exhausted"
            : authenticationFailure
              ? "authentication_failed"
              : "request_failed",
        permanent: authenticationFailure,
        quota,
        status: response.status,
      };
    }

    try {
      return { ok: true, data: parse(await response.json()), quota };
    } catch {
      return {
        ok: false,
        error: "request_failed",
        permanent: false,
        quota,
        status: response.status,
      };
    }
  }
}
