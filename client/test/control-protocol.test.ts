import { describe, expect, it } from "vitest";

import {
  commandResultSchema,
  controlRequestSchema,
  controlSnapshotSchema,
} from "../src/control-protocol.js";

const preset = {
  id: "11111111-1111-4111-8111-111111111111",
  workspaceId: "202",
  description: "Review",
  projectId: "404",
  taskId: null,
  tagIds: ["505"],
  tags: ["focus"],
  billable: false,
  projectColor: "#C9806B",
  projectName: "Internal",
  taskName: null,
  lastUsedAt: "2026-08-27T10:00:00Z",
};

const snapshot = {
  version: 1,
  type: "snapshot",
  status: "running",
  connection: "connected",
  confidence: "confirmed",
  pending: null,
  current: {
    id: "101",
    workspaceId: "202",
    description: "Review",
    projectId: "404",
    projectColor: "#C9806B",
    projectName: "Internal",
    start: "2026-08-27T10:00:00Z",
    taskName: "Pull requests",
  },
  timezone: "Africa/Cairo",
  completedTodaySeconds: 3600,
  currentContributesToToday: true,
  todayEntries: [
    {
      id: "102",
      description: "Planning",
      projectId: null,
      projectName: null,
      projectColor: null,
      taskName: null,
      start: "2026-08-27T08:00:00Z",
      stop: "2026-08-27T09:00:00Z",
      durationSeconds: 3600,
    },
    {
      id: "101",
      description: "Review",
      projectId: "404",
      projectName: "Internal",
      projectColor: "#C9806B",
      taskName: "Pull requests",
      start: "2026-08-27T10:00:00Z",
      stop: null,
      durationSeconds: null,
    },
  ],
  todayEntryCount: 3,
  todayEntriesOmitted: 1,
  month: {
    availability: "ready",
    partial: false,
    key: "2026-08",
    completedSeconds: 72_000,
    currentContributes: true,
    synchronizedAt: "2026-08-27T11:00:00Z",
  },
  presets: [preset],
  generatedAt: "2026-08-27T12:00:00Z",
  lastSynchronizedAt: "2026-08-27T11:00:00Z",
  error: null,
};

describe("local control protocol", () => {
  it("accepts only strict version-one requests with UUID preset IDs", () => {
    expect(controlRequestSchema.parse({ version: 1, type: "toggle" })).toEqual({
      version: 1,
      type: "toggle",
    });
    expect(
      controlRequestSchema.parse({ version: 1, type: "resume", presetId: preset.id }),
    ).toMatchObject({ type: "resume", presetId: preset.id });
    expect(() =>
      controlRequestSchema.parse({ version: 1, type: "stop", injected: true }),
    ).toThrow();
    expect(() =>
      controlRequestSchema.parse({ version: 1, type: "resume", presetId: "not-a-uuid" }),
    ).toThrow();
    expect(() =>
      controlSnapshotSchema.parse({
        version: 1,
        type: "snapshot",
        status: "idle",
        connection: "connected",
        confidence: "confirmed",
        pending: null,
        current: null,
        timezone: "Africa/Cairo",
        completedTodaySeconds: 0,
        currentContributesToToday: false,
        todayEntries: [],
        todayEntryCount: 0,
        todayEntriesOmitted: 0,
        month: {
          availability: "ready",
          partial: false,
          key: "2026-08",
          completedSeconds: 0,
          currentContributes: false,
          synchronizedAt: null,
        },
        presets: [{ ...preset, workspaceId: 202 }],
        generatedAt: "2026-08-27T12:00:00Z",
        lastSynchronizedAt: null,
        error: null,
      }),
    ).toThrow();
  });

  it("keeps results and snapshots inside closed strict unions", () => {
    expect(
      commandResultSchema.parse({
        version: 1,
        type: "result",
        outcome: "failed",
        error: "ambiguous_create",
      }),
    ).toMatchObject({ outcome: "failed", error: "ambiguous_create" });
    expect(
      commandResultSchema.parse({
        version: 1,
        type: "result",
        outcome: "failed",
        error: "command_busy",
      }),
    ).toMatchObject({ outcome: "failed", error: "command_busy" });
    expect(() =>
      commandResultSchema.parse({
        version: 1,
        type: "result",
        outcome: "retried",
        error: null,
      }),
    ).toThrow();

    expect(controlSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(() => controlSnapshotSchema.parse({ ...snapshot, confidence: "probably" })).toThrow();
    expect(() => controlSnapshotSchema.parse({ ...snapshot, extra: true })).toThrow();
  });

  it("rejects inconsistent Today entry accounting", () => {
    expect(() =>
      controlSnapshotSchema.parse({
        ...snapshot,
        todayEntryCount: 4,
      }),
    ).toThrow("Today entry accounting is inconsistent");
  });

  it("accepts only valid IANA timezones", () => {
    expect(controlSnapshotSchema.parse(snapshot).timezone).toBe("Africa/Cairo");
    expect(() =>
      controlSnapshotSchema.parse({
        ...snapshot,
        timezone: "Cairo time",
      }),
    ).toThrow("Invalid IANA timezone");
  });

  it("rejects malformed project colors", () => {
    expect(() =>
      controlSnapshotSchema.parse({
        ...snapshot,
        current: {
          ...snapshot.current,
          projectColor: "toggl-red",
        },
      }),
    ).toThrow();
  });

  it("preserves a partial stale month projection", () => {
    const staleSnapshot = {
      ...snapshot,
      connection: "stale",
      month: {
        ...snapshot.month,
        availability: "stale",
        partial: true,
      },
    };

    expect(controlSnapshotSchema.parse(staleSnapshot)).toEqual(staleSnapshot);
    expect(() =>
      controlSnapshotSchema.parse({
        ...staleSnapshot,
        month: { ...staleSnapshot.month, key: null },
      }),
    ).toThrow("Available month data requires a month key");
  });

  it("accepts the daemon-unavailable fallback without timezone or month key", () => {
    const unavailableSnapshot = {
      ...snapshot,
      status: "offline",
      connection: "offline",
      confidence: "uncertain",
      current: null,
      timezone: null,
      completedTodaySeconds: 0,
      currentContributesToToday: false,
      todayEntries: [],
      todayEntryCount: 0,
      todayEntriesOmitted: 0,
      month: {
        availability: "unavailable",
        partial: false,
        key: null,
        completedSeconds: 0,
        currentContributes: false,
        synchronizedAt: null,
      },
      presets: [],
      lastSynchronizedAt: null,
      error: "daemon_unavailable",
    };

    expect(controlSnapshotSchema.parse(unavailableSnapshot)).toEqual(unavailableSnapshot);
  });
});
