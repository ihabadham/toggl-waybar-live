import {
  externalIdSchema,
  type NormalizedEntry,
  normalizedEntrySchema,
  rfc3339Schema,
} from "@toggl-waybar-live/shared";

import { togglRequestDeadlineMilliseconds } from "./control-timing.js";
import type { DayWindow } from "./day-window.js";
import type { MonthWindow } from "./month-window.js";
import type { ResumeActivity } from "./presets.js";
import { type ProjectColor, projectColor } from "./project-color.js";

export interface QuotaStatus {
  remaining: number | null;
  resetsInSeconds: number | null;
}

export type ApiResult<T> =
  | { ok: true; data: T; quota: QuotaStatus }
  | {
      ok: false;
      error: "authentication_failed" | "quota_exhausted" | "request_failed";
      mayHaveSucceeded: boolean;
      permanent: boolean;
      quota: QuotaStatus;
      status: number | null;
    };

export interface RichTogglEntry extends NormalizedEntry {
  billable: boolean;
  projectColor: ProjectColor | null;
  tagIds: string[];
  tags: string[];
  taskId: string | null;
  taskName: string | null;
  updatedAt: string | null;
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type RequestMethod = "GET" | "POST" | "PATCH";
type UnknownRecord = Record<string, unknown>;

interface RequestOptions<T> {
  body?: unknown;
  currentNotFound?: T;
  method: RequestMethod;
  parse: (value: unknown) => T;
}

interface TimeEntryWindow {
  end: string;
  start: string;
}

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

function stringArray(value: unknown, name: string): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`invalid ${name}`);
  }
  return value.map((item) => {
    if (typeof item !== "string") {
      throw new Error(`invalid ${name}`);
    }
    return item;
  });
}

function externalIdArray(value: unknown, name: string): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`invalid ${name}`);
  }
  return value.map((item) => externalIdSchema.parse(item));
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`invalid ${name}`);
  }
  return value;
}

function normalizeEntry(value: unknown): RichTogglEntry {
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
  const rawTaskId = id(value, "task_id", "tid");

  return {
    ...normalizedEntrySchema.parse({
      id: value.id,
      workspaceId: id(value, "workspace_id", "wid"),
      userId: id(value, "user_id", "uid"),
      projectId: id(value, "project_id", "pid") ?? null,
      projectName: typeof value.project_name === "string" ? value.project_name : null,
      description: typeof value.description === "string" ? value.description : "",
      start,
      stop,
      durationSeconds,
    }),
    taskId:
      rawTaskId === null || rawTaskId === undefined ? null : externalIdSchema.parse(rawTaskId),
    taskName: typeof value.task_name === "string" ? value.task_name : null,
    projectColor: projectColor(value.project_color),
    tagIds: externalIdArray(value.tag_ids, "tag_ids"),
    tags: stringArray(value.tags, "tags"),
    billable: boolean(value.billable, "billable"),
    updatedAt: value.at === undefined || value.at === null ? null : rfc3339Schema.parse(value.at),
  };
}

function unwrapData(value: unknown): unknown {
  return isRecord(value) && "data" in value ? value.data : value;
}

function safeTogglId(value: string, name: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a safe integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a safe integer`);
  }
  return parsed;
}

function utcTimestamp(value: string): string {
  return new Date(rfc3339Schema.parse(value)).toISOString();
}

export class TogglApi {
  private readonly authorization: string;

  constructor(
    apiToken: string,
    private readonly fetcher: Fetcher = fetch,
    private readonly baseUrl = "https://api.track.toggl.com",
    private readonly deadlineMilliseconds = togglRequestDeadlineMilliseconds,
  ) {
    this.authorization = `Basic ${Buffer.from(`${apiToken}:api_token`, "utf8").toString("base64")}`;
  }

  async fetchToday(window: DayWindow): Promise<ApiResult<RichTogglEntry[]>> {
    return this.fetchEntries(window);
  }

  async fetchMonth(window: MonthWindow): Promise<ApiResult<RichTogglEntry[]>> {
    return this.fetchEntries(window);
  }

  private async fetchEntries(window: TimeEntryWindow): Promise<ApiResult<RichTogglEntry[]>> {
    const url = new URL("/api/v9/me/time_entries", this.baseUrl);
    url.searchParams.set("start_date", window.start);
    url.searchParams.set("end_date", window.end);
    url.searchParams.set("meta", "true");
    return this.request(url, {
      method: "GET",
      parse: (value) => {
        const data = unwrapData(value);
        if (!Array.isArray(data)) {
          throw new Error("invalid list");
        }
        return data.map(normalizeEntry);
      },
    });
  }

  async fetchCurrent(): Promise<ApiResult<RichTogglEntry | null>> {
    const url = new URL("/api/v9/me/time_entries/current", this.baseUrl);
    return this.request(url, {
      method: "GET",
      currentNotFound: null,
      parse: (value) => {
        const data = unwrapData(value);
        return data === null ? null : normalizeEntry(data);
      },
    });
  }

  async createRunningEntry(
    activity: ResumeActivity,
    start: string,
  ): Promise<ApiResult<RichTogglEntry>> {
    const workspaceId = safeTogglId(activity.workspaceId, "workspaceId");
    const projectId =
      activity.projectId === null ? undefined : safeTogglId(activity.projectId, "projectId");
    const taskId = activity.taskId === null ? undefined : safeTogglId(activity.taskId, "taskId");
    const tagIds = [...new Set(activity.tagIds)].sort().map((tagId) => safeTogglId(tagId, "tagId"));
    const tags = [...new Set(activity.tags)].sort();
    const url = new URL(`/api/v9/workspaces/${workspaceId}/time_entries`, this.baseUrl);
    return this.request(url, {
      method: "POST",
      body: {
        created_with: "toggl-waybar-live",
        workspace_id: workspaceId,
        description: activity.description,
        ...(projectId === undefined ? {} : { project_id: projectId }),
        ...(taskId === undefined ? {} : { task_id: taskId }),
        tag_ids: tagIds,
        tags,
        billable: activity.billable,
        start: utcTimestamp(start),
        duration: -1,
        stop: null,
      },
      parse: (value) => normalizeEntry(unwrapData(value)),
    });
  }

  async stopTimeEntry(workspaceId: string, entryId: string): Promise<ApiResult<RichTogglEntry>> {
    const workspace = safeTogglId(workspaceId, "workspaceId");
    const entry = safeTogglId(entryId, "entryId");
    const url = new URL(`/api/v9/workspaces/${workspace}/time_entries/${entry}/stop`, this.baseUrl);
    return this.request(url, {
      method: "PATCH",
      parse: (value) => normalizeEntry(unwrapData(value)),
    });
  }

  private async request<T>(url: URL, options: RequestOptions<T>): Promise<ApiResult<T>> {
    const mutation = options.method !== "GET";
    const abort = new AbortController();
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      deadlineTimer = setTimeout(() => {
        abort.abort();
        reject(new Error("Toggl request deadline exceeded"));
      }, this.deadlineMilliseconds);
    });
    const beforeDeadline = <Value>(promise: Promise<Value>): Promise<Value> =>
      Promise.race([promise, deadline]);
    try {
      let response: Response;
      try {
        const headers: Record<string, string> = {
          authorization: this.authorization,
          accept: "application/json",
        };
        if (options.body !== undefined) {
          headers["content-type"] = "application/json";
        }
        response = await beforeDeadline(
          this.fetcher(url, {
            method: options.method,
            headers,
            signal: abort.signal,
            ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          }),
        );
      } catch {
        return {
          ok: false,
          error: "request_failed",
          mayHaveSucceeded: mutation,
          permanent: false,
          quota: { remaining: null, resetsInSeconds: null },
          status: null,
        };
      }

      const quota = quotaFrom(response);
      if (response.status === 404 && options.currentNotFound !== undefined) {
        return { ok: true, data: options.currentNotFound, quota };
      }
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
          mayHaveSucceeded: mutation && response.status >= 500,
          permanent: authenticationFailure,
          quota,
          status: response.status,
        };
      }

      try {
        return { ok: true, data: options.parse(await beforeDeadline(response.json())), quota };
      } catch {
        return {
          ok: false,
          error: "request_failed",
          mayHaveSucceeded: mutation,
          permanent: false,
          quota,
          status: response.status,
        };
      }
    } finally {
      clearTimeout(deadlineTimer);
    }
  }
}
