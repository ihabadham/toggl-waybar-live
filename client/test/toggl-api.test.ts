import { describe, expect, it, vi } from "vitest";

import { dayWindowAt } from "../src/day-window.js";
import { monthWindowAt } from "../src/month-window.js";
import { TogglApi } from "../src/toggl-api.js";

const token = "private-test-token";
const window = dayWindowAt("2026-08-27T12:00:00Z", "Africa/Cairo");

const apiEntry = {
  id: 101,
  workspace_id: 202,
  user_id: 303,
  project_id: 404,
  project_name: "Internal",
  project_color: "#c9806b",
  task_id: 505,
  task_name: "Write tests",
  tag_ids: [607, 606],
  tags: ["client", "urgent"],
  billable: true,
  at: "2026-08-27T10:00:00Z",
  description: "Review",
  start: "2026-08-27T10:00:00Z",
  stop: null,
  duration: -1,
};

describe("Toggl API", () => {
  it("requests and normalizes today's entries with exact bounds and Basic auth", async () => {
    const requests: Array<{ authorization: string | null; url: string }> = [];
    const api = new TogglApi(token, async (input, init) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return Response.json([apiEntry], {
        headers: {
          "x-toggl-quota-remaining": "28",
          "x-toggl-quota-resets-in": "1750",
        },
      });
    });

    const result = await api.fetchToday(window);

    expect(requests).toEqual([
      {
        url:
          "https://api.track.toggl.com/api/v9/me/time_entries?" +
          "start_date=2026-08-26T21%3A00%3A00.000Z&" +
          "end_date=2026-08-27T21%3A00%3A00.000Z&meta=true",
        authorization: `Basic ${Buffer.from(`${token}:api_token`).toString("base64")}`,
      },
    ]);
    expect(result).toEqual({
      ok: true,
      data: [
        {
          id: "101",
          workspaceId: "202",
          userId: "303",
          projectId: "404",
          projectColor: "#c9806b",
          projectName: "Internal",
          description: "Review",
          start: "2026-08-27T10:00:00Z",
          stop: null,
          durationSeconds: null,
          taskId: "505",
          taskName: "Write tests",
          tagIds: ["607", "606"],
          tags: ["client", "urgent"],
          billable: true,
          updatedAt: "2026-08-27T10:00:00Z",
        },
      ],
      quota: { remaining: 28, resetsInSeconds: 1_750 },
    });
  });

  it("requests the current local month without dropping a ceiling-sized response", async () => {
    const requests: string[] = [];
    const entries = Array.from({ length: 1_000 }, (_, index) => ({
      ...apiEntry,
      id: index + 1,
    }));
    const api = new TogglApi(token, async (input) => {
      requests.push(String(input));
      return Response.json(entries);
    });

    const result = await api.fetchMonth(monthWindowAt("2026-08-15T12:00:00Z", "Africa/Cairo"));

    expect(requests).toEqual([
      "https://api.track.toggl.com/api/v9/me/time_entries?" +
        "start_date=2026-07-31T21%3A00%3A00.000Z&" +
        "end_date=2026-08-31T21%3A00%3A00.000Z&meta=true",
    ]);
    expect(result).toMatchObject({ ok: true, data: expect.any(Array) });
    if (result.ok) {
      expect(result.data).toHaveLength(1_000);
    }
  });

  it("falls back to no project color when Toggl metadata is malformed", async () => {
    const api = new TogglApi(token, async () =>
      Response.json([{ ...apiEntry, project_color: "not-a-color" }]),
    );

    await expect(api.fetchToday(window)).resolves.toMatchObject({
      ok: true,
      data: [{ projectColor: null }],
    });
  });

  it("normalizes a nested current response and completed duration", async () => {
    const api = new TogglApi(token, async () =>
      Response.json({
        data: {
          ...apiEntry,
          stop: "2026-08-27T10:30:00Z",
          duration: 1_800,
        },
      }),
    );

    const result = await api.fetchCurrent();

    expect(result).toMatchObject({
      ok: true,
      data: { id: "101", durationSeconds: 1_800 },
    });
  });

  it("accepts a nested list and a null current entry", async () => {
    const responses = [Response.json({ data: [apiEntry] }), Response.json({ data: null })];
    const api = new TogglApi(token, async () => responses.shift() as Response);

    await expect(api.fetchToday(window)).resolves.toMatchObject({
      ok: true,
      data: [{ id: "101" }],
    });
    await expect(api.fetchCurrent()).resolves.toEqual({
      ok: true,
      data: null,
      quota: { remaining: null, resetsInSeconds: null },
    });
  });

  it("treats a missing current entry as confirmed idle", async () => {
    const api = new TogglApi(
      token,
      async () =>
        new Response("not found", {
          status: 404,
          headers: { "x-toggl-quota-remaining": "27", "x-toggl-quota-resets-in": "90" },
        }),
    );

    await expect(api.fetchCurrent()).resolves.toEqual({
      ok: true,
      data: null,
      quota: { remaining: 27, resetsInSeconds: 90 },
    });
  });

  it("creates and stops entries with the exact workspace-scoped requests", async () => {
    const requests: RequestInit[] = [];
    const urls: string[] = [];
    const api = new TogglApi(token, async (input, init) => {
      urls.push(String(input));
      requests.push(init ?? {});
      return Response.json(apiEntry, {
        headers: { "x-toggl-quota-remaining": "26", "x-toggl-quota-resets-in": "80" },
      });
    });

    const activity = {
      workspaceId: "202",
      description: "Review",
      projectId: "404",
      taskId: "505",
      tagIds: ["607", "606", "607"],
      tags: ["urgent", "client", "urgent"],
      billable: true,
    };
    await api.createRunningEntry(activity, "2026-08-27T12:30:00+02:00");
    await api.stopTimeEntry("202", "101");

    expect(urls).toEqual([
      "https://api.track.toggl.com/api/v9/workspaces/202/time_entries",
      "https://api.track.toggl.com/api/v9/workspaces/202/time_entries/101/stop",
    ]);
    expect(
      requests.map((request) => ({
        method: request.method,
        headers: Object.fromEntries(new Headers(request.headers)),
        body: request.body,
      })),
    ).toEqual([
      {
        method: "POST",
        headers: expect.objectContaining({
          authorization: `Basic ${Buffer.from(`${token}:api_token`).toString("base64")}`,
          accept: "application/json",
          "content-type": "application/json",
        }),
        body: JSON.stringify({
          created_with: "toggl-waybar-live",
          workspace_id: 202,
          description: "Review",
          project_id: 404,
          task_id: 505,
          tag_ids: [606, 607],
          tags: ["client", "urgent"],
          billable: true,
          start: "2026-08-27T10:30:00.000Z",
          duration: -1,
          stop: null,
        }),
      },
      {
        method: "PATCH",
        headers: expect.objectContaining({
          authorization: `Basic ${Buffer.from(`${token}:api_token`).toString("base64")}`,
          accept: "application/json",
        }),
        body: undefined,
      },
    ]);
    expect(new Headers(requests[1]?.headers).has("content-type")).toBe(false);
  });

  it("marks only ambiguous mutation failures as potentially successful", async () => {
    const responses = [
      new Response("upstream", { status: 503 }),
      Response.json({ unexpected: true }),
      new Response("invalid", { status: 400 }),
      new Response("already stopped", { status: 409 }),
      new Response("missing", { status: 404 }),
    ];
    const api = new TogglApi(token, async () => responses.shift() as Response);
    const activity = {
      workspaceId: "202",
      description: "Review",
      projectId: null,
      taskId: null,
      tagIds: [],
      tags: [],
      billable: false,
    };
    const network = new TogglApi(token, async () => {
      throw new Error("offline");
    });

    const results = [
      await network.createRunningEntry(activity, "2026-08-27T10:00:00Z"),
      await api.createRunningEntry(activity, "2026-08-27T10:00:00Z"),
      await api.createRunningEntry(activity, "2026-08-27T10:00:00Z"),
      await api.createRunningEntry(activity, "2026-08-27T10:00:00Z"),
      await api.stopTimeEntry("202", "101"),
      await api.stopTimeEntry("202", "101"),
    ];

    expect(
      results.map((result) => (result.ok ? null : [result.status, result.mayHaveSucceeded])),
    ).toEqual([
      [null, true],
      [503, true],
      [200, true],
      [400, false],
      [409, false],
      [404, false],
    ]);
  });

  it("treats missing or malformed billable mutation responses as ambiguous failures", async () => {
    const { billable: _billable, ...withoutBillable } = apiEntry;
    const responses = [
      Response.json(withoutBillable),
      Response.json({ ...apiEntry, billable: "yes" }),
    ];
    const api = new TogglApi(token, async () => responses.shift() as Response);
    const activity = {
      workspaceId: "202",
      description: "Review",
      projectId: null,
      taskId: null,
      tagIds: [],
      tags: [],
      billable: false,
    };

    const results = [
      await api.createRunningEntry(activity, "2026-08-27T10:00:00Z"),
      await api.createRunningEntry(activity, "2026-08-27T10:00:00Z"),
    ];

    expect(results).toMatchObject([
      { ok: false, status: 200, mayHaveSucceeded: true },
      { ok: false, status: 200, mayHaveSucceeded: true },
    ]);
  });

  it("rejects unsafe mutation IDs before making a request", async () => {
    let calls = 0;
    const api = new TogglApi(token, async () => {
      calls += 1;
      return Response.json(apiEntry);
    });
    const activity = {
      workspaceId: "9007199254740992",
      description: "Review",
      projectId: null,
      taskId: null,
      tagIds: [],
      tags: [],
      billable: false,
    };

    await expect(api.createRunningEntry(activity, "2026-08-27T10:00:00Z")).rejects.toThrow(
      "safe integer",
    );
    await expect(api.stopTimeEntry("202", "9007199254740992")).rejects.toThrow("safe integer");
    expect(calls).toBe(0);
  });

  it("classifies quota, authentication, and transient failures without exposing secrets", async () => {
    const responses = [
      new Response("quota", {
        status: 402,
        headers: { "x-toggl-quota-resets-in": "120" },
      }),
      new Response("unauthorized", { status: 401 }),
      new Response("upstream", { status: 503 }),
    ];
    const api = new TogglApi(token, async () => responses.shift() as Response);

    const quota = await api.fetchCurrent();
    const authentication = await api.fetchCurrent();
    const transient = await api.fetchCurrent();

    expect(quota).toMatchObject({
      ok: false,
      error: "quota_exhausted",
      permanent: false,
      status: 402,
      quota: { resetsInSeconds: 120 },
    });
    expect(authentication).toMatchObject({
      ok: false,
      error: "authentication_failed",
      permanent: true,
      status: 401,
    });
    expect(transient).toMatchObject({
      ok: false,
      error: "request_failed",
      permanent: false,
      status: 503,
    });
    expect(JSON.stringify([quota, authentication, transient])).not.toContain(token);
  });

  it("turns network and invalid-response failures into secret-free results", async () => {
    const failing = new TogglApi(token, async () => {
      throw new Error(`network failed for ${token}`);
    });
    const invalid = new TogglApi(token, async () => Response.json({ unexpected: true }));

    const results = [await failing.fetchCurrent(), await invalid.fetchCurrent()];
    expect(results).toMatchObject([
      { ok: false, error: "request_failed", status: null },
      { ok: false, error: "request_failed", status: 200 },
    ]);
    expect(JSON.stringify(results)).not.toContain(token);
  });

  it("aborts and bounds hanging GET and mutation fetches", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const signals: AbortSignal[] = [];
      const api = new TogglApi(
        token,
        async (_input, init) => {
          if (init?.signal) {
            signals.push(init.signal);
          }
          return new Promise<Response>(() => undefined);
        },
        "https://api.track.toggl.com",
        25,
      );

      const read = api.fetchCurrent();
      await vi.advanceTimersByTimeAsync(25);
      await expect(read).resolves.toMatchObject({
        ok: false,
        error: "request_failed",
        mayHaveSucceeded: false,
        status: null,
      });

      const mutation = api.stopTimeEntry("202", "101");
      await vi.advanceTimersByTimeAsync(25);
      await expect(mutation).resolves.toMatchObject({
        ok: false,
        error: "request_failed",
        mayHaveSucceeded: true,
        status: null,
      });
      expect(signals).toHaveLength(2);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the request deadline active while a successful response body hangs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let signal: AbortSignal | null = null;
      const response = Response.json(apiEntry);
      Object.defineProperty(response, "json", {
        value: () => new Promise<never>(() => undefined),
      });
      const api = new TogglApi(
        token,
        async (_input, init) => {
          signal = init?.signal ?? null;
          return response;
        },
        "https://api.track.toggl.com",
        25,
      );

      const mutation = api.stopTimeEntry("202", "101");
      await vi.advanceTimersByTimeAsync(25);

      await expect(mutation).resolves.toMatchObject({
        ok: false,
        error: "request_failed",
        mayHaveSucceeded: true,
        status: 200,
      });
      expect(signal).toMatchObject({ aborted: true });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
