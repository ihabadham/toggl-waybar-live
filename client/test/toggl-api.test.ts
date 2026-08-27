import { describe, expect, it } from "vitest";

import { dayWindowAt } from "../src/day-window.js";
import { TogglApi } from "../src/toggl-api.js";

const token = "private-test-token";
const window = dayWindowAt("2026-08-27T12:00:00Z", "Africa/Cairo");

const apiEntry = {
  id: 101,
  workspace_id: 202,
  user_id: 303,
  project_id: 404,
  project_name: "Internal",
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
          projectName: "Internal",
          description: "Review",
          start: "2026-08-27T10:00:00Z",
          stop: null,
          durationSeconds: null,
        },
      ],
      quota: { remaining: 28, resetsInSeconds: 1_750 },
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
});
