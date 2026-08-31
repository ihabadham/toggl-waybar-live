import { describe, expect, it } from "vitest";

import {
  type ControlSnapshot,
  type ControlTodayEntry,
  controlFrameBytes,
} from "../src/control-protocol.js";
import {
  boundedControlSnapshot,
  type ControlSnapshotBase,
  chronologicalTodayEntries,
} from "../src/control-snapshot.js";
import { type ClientEntry, type ClientState, createState } from "../src/state.js";

function entry(id: string, start: string, description = "Review"): ClientEntry {
  return {
    id,
    workspaceId: "202",
    userId: "303",
    projectId: "404",
    projectName: "Internal",
    projectColor: "#c9806b",
    taskName: "PR review",
    description,
    start,
    stop: "2026-08-27T11:00:00Z",
    durationSeconds: 1_800,
  };
}

function base(overrides: Partial<ControlSnapshotBase> = {}): ControlSnapshotBase {
  return {
    version: 1,
    type: "snapshot",
    status: "idle",
    connection: "connected",
    confidence: "confirmed",
    pending: null,
    current: null,
    timezone: "Africa/Cairo",
    completedTodaySeconds: 3_600,
    currentContributesToToday: false,
    month: {
      availability: "ready",
      partial: false,
      key: "2026-08",
      completedSeconds: 7_200,
      currentContributes: false,
      synchronizedAt: "2026-08-27T11:00:00Z",
    },
    presets: [],
    generatedAt: "2026-08-27T12:00:00Z",
    lastSynchronizedAt: "2026-08-27T11:00:00Z",
    error: null,
    ...overrides,
  };
}

describe("bounded control snapshots", () => {
  it("keeps chronological segments distinct and unions the current row by ID", () => {
    const initial = createState("2026-08-27");
    const state: ClientState = {
      ...initial,
      current: {
        id: "103",
        workspaceId: "202",
        description: "Review",
        projectId: "404",
        projectName: "Internal",
        projectColor: "#c9806b",
        taskName: "PR review",
        start: "2026-08-27T11:30:00Z",
      },
      currentContributesToToday: true,
      entries: new Map([
        ["101", entry("101", "2026-08-27T09:00:00Z")],
        ["102", entry("102", "2026-08-27T10:00:00Z")],
        ["103", entry("103", "2026-08-27T08:00:00Z", "Stale row")],
      ]),
    };

    const rows = chronologicalTodayEntries(state);

    expect(rows.map(({ id }) => id)).toEqual(["103", "102", "101"]);
    expect(rows.filter(({ description }) => description === "Review")).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      id: "103",
      description: "Review",
      start: "2026-08-27T11:30:00Z",
      stop: null,
    });
  });

  it("caps visible history at 50 rows and accounts for every omission", () => {
    const rows = Array.from({ length: 55 }, (_, index) => ({
      ...entry(String(1_000 + index), `2026-08-27T${String(index % 24).padStart(2, "0")}:00:00Z`),
      stop: null,
    }));

    const snapshot = boundedControlSnapshot(base(), rows, Number.POSITIVE_INFINITY);

    expect(snapshot.todayEntries).toHaveLength(50);
    expect(snapshot.todayEntryCount).toBe(55);
    expect(snapshot.todayEntriesOmitted).toBe(5);
  });

  it("uses UTF-8 frame bytes and never truncates an included label", () => {
    const first: ControlTodayEntry = entry("101", "2026-08-27T10:00:00Z", "Complete label");
    const second: ControlTodayEntry = entry("102", "2026-08-27T09:00:00Z", "🔥".repeat(2_000));
    const oneRow: ControlSnapshot = {
      ...base(),
      todayEntries: [first],
      todayEntryCount: 2,
      todayEntriesOmitted: 1,
    };

    const snapshot = boundedControlSnapshot(base(), [first, second], controlFrameBytes(oneRow));

    expect(snapshot.todayEntries).toEqual([first]);
    expect(snapshot.todayEntries[0]?.description).toBe("Complete label");
    expect(snapshot.todayEntriesOmitted).toBe(1);
    expect(controlFrameBytes(snapshot)).toBeLessThanOrEqual(controlFrameBytes(oneRow));
  });
});
