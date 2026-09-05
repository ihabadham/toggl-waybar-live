import type { NormalizedEntry, RelayMessage } from "@toggl-waybar-live/shared";
import { describe, expect, it } from "vitest";

import {
  advanceMonth,
  applyMonthEntry,
  applyMonthRelayMessage,
  completedMonthSeconds,
  completedWeekSeconds,
  createMonthState,
  markMonthRefreshFailed,
  replaceReconciledMonthEntries,
} from "../src/month-state.js";
import { periodWindowAt } from "../src/period-window.js";

const august = periodWindowAt("2026-08-15T12:00:00Z", "Africa/Cairo", 0);
const september = periodWindowAt("2026-09-15T12:00:00Z", "Africa/Cairo", 0);

function entry(overrides: Partial<NormalizedEntry> = {}): NormalizedEntry {
  return {
    id: "101",
    workspaceId: "202",
    userId: "303",
    projectId: "404",
    projectName: "Internal",
    description: "Review",
    start: "2026-08-10T10:00:00Z",
    stop: "2026-08-10T11:00:00Z",
    durationSeconds: 3_600,
    ...overrides,
  };
}

function changed(
  value: NormalizedEntry,
  action: "created" | "updated" | "deleted" = "updated",
): RelayMessage {
  return { version: 1, type: "entry.changed", change: { action, entry: value } };
}

describe("current month state", () => {
  it("replaces only entries whose starts belong to the local month", () => {
    const state = replaceReconciledMonthEntries(
      createMonthState(august),
      [
        entry(),
        entry({ id: "102", start: "2026-07-31T20:59:59Z" }),
        entry({ id: "103", start: august.end }),
      ],
      august,
      "2026-08-15T12:00:00Z",
      false,
    );

    expect([...state.entries.keys()]).toEqual(["101"]);
    expect(state).toMatchObject({
      availability: "ready",
      monthKey: "2026-08",
      partial: false,
      synchronizedAt: "2026-08-15T12:00:00Z",
    });
    expect(completedMonthSeconds(state, august)).toBe(3_600);
  });

  it("merges local and webhook changes and deletes by entry identity", () => {
    let state = applyMonthEntry(createMonthState(august), entry(), august);
    state = applyMonthRelayMessage(
      state,
      changed(entry({ durationSeconds: 5_400, stop: "2026-08-10T11:30:00Z" })),
      august,
    );
    expect(completedMonthSeconds(state, august)).toBe(5_400);

    state = applyMonthRelayMessage(
      state,
      changed(entry({ stop: null, durationSeconds: null })),
      august,
    );
    expect(completedMonthSeconds(state, august)).toBe(5_400);

    state = applyMonthEntry(state, entry({ id: "102", stop: null, durationSeconds: null }), august);
    expect(state.entries.has("102")).toBe(true);

    state = applyMonthRelayMessage(state, changed(entry(), "deleted"), august);
    expect([...state.entries.keys()]).toEqual(["102"]);
  });

  it("preserves a partial lower bound when a later refresh fails", () => {
    const ready = replaceReconciledMonthEntries(
      createMonthState(august),
      [entry()],
      august,
      "2026-08-15T12:00:00Z",
      true,
    );
    const stale = markMonthRefreshFailed(ready, august);

    expect(stale).toMatchObject({ availability: "stale", partial: true });
    expect(stale.entries).toEqual(ready.entries);
    expect(markMonthRefreshFailed(createMonthState(august), august).availability).toBe(
      "unavailable",
    );
  });

  it("retains only cross-month week entries and marks them stale at month rollover", () => {
    const augustState = replaceReconciledMonthEntries(
      createMonthState(august),
      [entry()],
      august,
      "2026-08-31T20:00:00Z",
      true,
    );

    expect(advanceMonth(augustState, september)).toMatchObject({
      availability: "stale",
      entries: new Map(),
      monthKey: "2026-09",
      partial: true,
      synchronizedAt: "2026-08-31T20:00:00Z",
    });
  });

  it("derives week and month totals independently across a month boundary", () => {
    const boundary = periodWindowAt("2026-09-01T12:00:00Z", "Africa/Cairo", 0);
    const state = replaceReconciledMonthEntries(
      createMonthState(boundary),
      [
        entry({ id: "august", start: "2026-08-30T08:00:00Z" }),
        entry({ id: "september", start: "2026-09-01T08:00:00Z", durationSeconds: 1_800 }),
      ],
      boundary,
      "2026-09-01T12:00:00Z",
      false,
    );

    expect(completedWeekSeconds(state, boundary)).toBe(5_400);
    expect(completedMonthSeconds(state, boundary)).toBe(1_800);
  });
});
