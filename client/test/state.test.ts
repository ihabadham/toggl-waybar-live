import type { NormalizedEntry, RelayMessage } from "@toggl-waybar-live/shared";
import { describe, expect, it } from "vitest";

import { loadConfig, loadRendererOptions } from "../src/config.js";
import { dayWindowAt } from "../src/day-window.js";
import {
  applyRelayMessage,
  createState,
  replaceReconciledEntries,
  setConnection,
  toRendererState,
} from "../src/state.js";

const window = dayWindowAt("2026-08-27T12:00:00Z", "Africa/Cairo");

function entry(overrides: Partial<NormalizedEntry> = {}): NormalizedEntry {
  return {
    id: "101",
    workspaceId: "202",
    userId: "303",
    projectId: "404",
    projectName: "Internal",
    description: "Review",
    start: "2026-08-27T10:00:00Z",
    stop: null,
    durationSeconds: null,
    ...overrides,
  };
}

function runningSnapshot(value: NormalizedEntry = entry()): RelayMessage {
  return {
    version: 1,
    type: "snapshot",
    snapshot: {
      status: "running",
      entryId: value.id,
      workspaceId: value.workspaceId,
      projectId: value.projectId,
      description: value.description,
      start: value.start,
      eventId: "10",
      eventCreatedAt: "2026-08-27T10:00:01Z",
    },
  };
}

function changed(value: NormalizedEntry, action: "created" | "updated" = "created"): RelayMessage {
  return { version: 1, type: "entry.changed", change: { action, entry: value } };
}

describe("local day windows", () => {
  it("turns Cairo midnight into UTC boundaries", () => {
    expect(window).toEqual({
      dayKey: "2026-08-27",
      start: "2026-08-26T21:00:00.000Z",
      end: "2026-08-27T21:00:00.000Z",
    });
  });
});

describe("client state", () => {
  it("applies relay start and stop messages without losing the completed total", () => {
    const runningEntry = entry();
    let state = setConnection(createState(window.dayKey), "connected");
    state = applyRelayMessage(state, runningSnapshot(runningEntry), window);
    state = applyRelayMessage(state, changed(runningEntry), window);

    expect(toRendererState(state, "2026-08-27T10:30:00Z")).toMatchObject({
      status: "running",
      label: "Review",
      todayTrackedSeconds: 1_800,
      runningContributesToToday: true,
    });

    state = applyRelayMessage(
      state,
      {
        version: 1,
        type: "snapshot",
        snapshot: {
          status: "idle",
          updatedAt: "2026-08-27T11:00:00Z",
          eventId: "11",
          eventCreatedAt: "2026-08-27T11:00:00Z",
        },
      },
      window,
    );
    state = applyRelayMessage(
      state,
      changed(
        entry({
          stop: "2026-08-27T11:00:00Z",
          durationSeconds: 3_600,
        }),
        "updated",
      ),
      window,
    );

    expect(toRendererState(state, "2026-08-27T12:00:00Z")).toMatchObject({
      status: "idle",
      todayTrackedSeconds: 3_600,
      runningContributesToToday: false,
    });
  });

  it("removes a deleted entry from today's total", () => {
    const completed = entry({ stop: "2026-08-27T11:00:00Z", durationSeconds: 3_600 });
    let state = applyRelayMessage(createState(window.dayKey), changed(completed), window);
    state = applyRelayMessage(
      state,
      {
        version: 1,
        type: "entry.changed",
        change: {
          action: "deleted",
          entry: { id: completed.id, workspaceId: completed.workspaceId, userId: completed.userId },
        },
      },
      window,
    );

    expect(state.entries.size).toBe(0);
  });

  it("keeps a pre-midnight current entry visible without adding it to today's total", () => {
    const beforeMidnight = entry({ start: "2026-08-26T20:30:00Z" });
    let state = setConnection(createState(window.dayKey), "connected");
    state = applyRelayMessage(state, runningSnapshot(beforeMidnight), window);

    expect(toRendererState(state, "2026-08-27T12:00:00Z")).toMatchObject({
      status: "running",
      entryStart: "2026-08-26T20:30:00Z",
      todayTrackedSeconds: 0,
      runningContributesToToday: false,
    });
  });

  it("replaces entries from reconciliation and filters entries outside the local day", () => {
    const completed = entry({ stop: "2026-08-27T11:00:00Z", durationSeconds: 3_600 });
    const yesterday = entry({ id: "999", start: "2026-08-26T20:00:00Z" });
    const synchronized = replaceReconciledEntries(
      setConnection(createState(window.dayKey), "connected"),
      [completed, yesterday],
      null,
      window,
      "2026-08-27T12:00:00Z",
    );

    expect([...synchronized.entries.keys()]).toEqual(["101"]);
    expect(toRendererState(synchronized, "2026-08-27T12:00:00Z")).toMatchObject({
      todayTrackedSeconds: 3_600,
      lastSynchronizedAt: "2026-08-27T12:00:00Z",
    });
  });

  it("clears completed entries at a day change but retains a current entry", () => {
    const completed = entry({ stop: "2026-08-27T11:00:00Z", durationSeconds: 3_600 });
    let state = applyRelayMessage(createState(window.dayKey), changed(completed), window);
    state = applyRelayMessage(state, runningSnapshot(entry({ id: "202" })), window);

    const tomorrow = dayWindowAt("2026-08-27T22:00:00Z", "Africa/Cairo");
    state = applyRelayMessage(state, runningSnapshot(entry({ id: "202" })), tomorrow);

    expect(state.dayKey).toBe("2026-08-28");
    expect(state.entries.size).toBe(0);
    expect(state.current?.id).toBe("202");
    expect(state.currentContributesToToday).toBe(false);
  });
});

describe("client configuration", () => {
  const validEnvironment = {
    TOGGL_API_TOKEN: "api-token",
    TOGGL_TIMEZONE: "Africa/Cairo",
    TOGGL_RELAY_URL: "wss://relay.example/ws",
    TOGGL_RELAY_TOKEN: "relay-token",
  };

  it("loads strict configuration with the compact default label", () => {
    expect(loadConfig(validEnvironment)).toMatchObject({
      timezone: "Africa/Cairo",
      relayUrl: "wss://relay.example/ws",
      labelMaxChars: 12,
    });
  });

  it("loads renderer options without daemon credentials", () => {
    expect(loadRendererOptions({})).toEqual({ labelMaxChars: 12 });
    expect(loadRendererOptions({ TOGGL_LABEL_MAX_CHARS: "8" })).toEqual({ labelMaxChars: 8 });
  });

  it("allows insecure WebSockets only on localhost", () => {
    expect(
      loadConfig({ ...validEnvironment, TOGGL_RELAY_URL: "ws://127.0.0.1:8787/ws" }).relayUrl,
    ).toBe("ws://127.0.0.1:8787/ws");
    expect(() =>
      loadConfig({ ...validEnvironment, TOGGL_RELAY_URL: "ws://relay.example/ws" }),
    ).toThrow("TOGGL_RELAY_URL");
  });

  it("names invalid variables without exposing their values", () => {
    expect(() =>
      loadConfig({ ...validEnvironment, TOGGL_TIMEZONE: "private-invalid-value" }),
    ).toThrowError("TOGGL_TIMEZONE must be a valid IANA timezone");
  });
});
