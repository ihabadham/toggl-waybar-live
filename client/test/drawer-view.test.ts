import { describe, expect, it } from "vitest";

import type { ControlSnapshot } from "../src/control-protocol.js";
import { drawerView } from "../src/drawer-view.js";

function snapshot(overrides: Partial<ControlSnapshot> = {}): ControlSnapshot {
  return {
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
      projectId: "303",
      projectColor: "#c9806b",
      projectName: "Internal",
      start: "2026-08-27T10:00:00Z",
      taskName: "PR review",
    },
    timezone: "Africa/Cairo",
    completedTodaySeconds: 3_600,
    currentContributesToToday: true,
    todayEntries: [
      {
        id: "101",
        description: "Review",
        projectId: "303",
        projectName: "Internal",
        projectColor: "#c9806b",
        taskName: "PR review",
        start: "2026-08-27T10:00:00Z",
        stop: null,
        durationSeconds: null,
      },
    ],
    todayEntryCount: 1,
    todayEntriesOmitted: 0,
    month: {
      availability: "ready",
      partial: false,
      key: "2026-08",
      completedSeconds: 7_200,
      currentContributes: true,
      synchronizedAt: "2026-08-27T11:00:00Z",
    },
    week: {
      availability: "ready",
      partial: false,
      key: "2026-08-23",
      completedSeconds: 5_400,
      currentContributes: true,
      synchronizedAt: "2026-08-27T11:00:00Z",
    },
    presets: [
      {
        id: "0182cc10-54d1-7c35-b4f3-e93bb4c0b100",
        workspaceId: "202",
        description: "$(touch /tmp/not-a-command)",
        projectId: "303",
        taskId: "404",
        tagIds: ["505"],
        tags: ["client; shutdown now"],
        billable: true,
        projectColor: "#c9806b",
        projectName: "R&D",
        taskName: "PR review",
        lastUsedAt: "2026-08-27T09:00:00Z",
      },
    ],
    generatedAt: "2026-08-27T11:00:00Z",
    lastSynchronizedAt: "2026-08-27T11:00:00Z",
    error: null,
    ...overrides,
  };
}

function expectOnlyNonNullPrimitives(record: object): void {
  for (const value of Object.values(record)) {
    expect(value).not.toBeNull();
    expect(["boolean", "number", "string"]).toContain(typeof value);
  }
}

describe("drawer view", () => {
  it("advances the current, Today row, Today, week, and month totals from one clock tick", () => {
    const before = drawerView(snapshot(), "2026-08-27T11:00:59Z");
    const after = drawerView(snapshot(), "2026-08-27T11:01:00Z");

    expect(before.current?.elapsed).toBe("01:00:59");
    expect(before.todayEntries[0]?.duration).toBe("01:00:59");
    expect(before.today).toBe("02:00:59");
    expect(before.week).toEqual({ availability: "ready", value: "2h 30m", cue: "" });
    expect(before.month).toEqual({ availability: "ready", value: "3h 00m", cue: "" });

    expect(after.current?.elapsed).toBe("01:01:00");
    expect(after.todayEntries[0]?.duration).toBe("01:01:00");
    expect(after.today).toBe("02:01:00");
    expect(after.week).toEqual({ availability: "ready", value: "2h 31m", cue: "" });
    expect(after.month).toEqual({ availability: "ready", value: "3h 01m", cue: "" });
  });

  it("keeps completed entries with repeated descriptions separate and in snapshot order", () => {
    const view = drawerView(
      snapshot({
        status: "idle",
        current: null,
        completedTodaySeconds: 3_300,
        currentContributesToToday: false,
        todayEntries: [
          {
            id: "902",
            description: "Review",
            projectId: null,
            projectName: null,
            projectColor: null,
            taskName: null,
            start: "2026-08-27T09:00:00Z",
            stop: "2026-08-27T09:15:00Z",
            durationSeconds: null,
          },
          {
            id: "901",
            description: "Review",
            projectId: null,
            projectName: null,
            projectColor: null,
            taskName: null,
            start: "2026-08-27T08:00:00Z",
            stop: "2026-08-27T08:40:00Z",
            durationSeconds: 2_400,
          },
        ],
        todayEntryCount: 2,
        month: {
          availability: "ready",
          partial: false,
          key: "2026-08",
          completedSeconds: 7_200,
          currentContributes: false,
          synchronizedAt: "2026-08-27T11:00:00Z",
        },
      }),
    );

    expect(view.todayEntries).toEqual([
      {
        id: "902",
        label: "Review",
        context: "",
        markerColor: "#bfa894",
        markerVisible: false,
        range: "12:00 – 12:15",
        duration: "00:15:00",
        running: false,
      },
      {
        id: "901",
        label: "Review",
        context: "",
        markerColor: "#bfa894",
        markerVisible: false,
        range: "11:00 – 11:40",
        duration: "00:40:00",
        running: false,
      },
    ]);
    view.todayEntries.forEach(expectOnlyNonNullPrimitives);
  });

  it("formats completed ranges in the configured timezone across a DST transition", () => {
    const view = drawerView(
      snapshot({
        status: "idle",
        current: null,
        timezone: "America/New_York",
        completedTodaySeconds: 3_600,
        currentContributesToToday: false,
        todayEntries: [
          {
            id: "901",
            description: "DST handoff",
            projectId: null,
            projectName: null,
            projectColor: null,
            taskName: null,
            start: "2026-03-08T06:30:00Z",
            stop: "2026-03-08T07:30:00Z",
            durationSeconds: null,
          },
        ],
        todayEntryCount: 1,
        month: {
          availability: "ready",
          partial: false,
          key: "2026-03",
          completedSeconds: 3_600,
          currentContributes: false,
          synchronizedAt: "2026-03-08T08:00:00Z",
        },
      }),
    );

    expect(view.todayEntries[0]).toMatchObject({
      range: "01:30 – 03:30",
      duration: "01:00:00",
    });
  });

  it("keeps labels as raw data and projects deduplicated context with safe marker colors", () => {
    const hostileCurrentLabel = "$(touch /tmp/not-a-command)";
    const hostilePresetLabel = "client; shutdown now";
    const view = drawerView(
      snapshot({
        current: {
          id: "101",
          workspaceId: "202",
          description: hostileCurrentLabel,
          projectId: "303",
          projectColor: "#A1b2C3",
          projectName: "Internal",
          start: "2026-08-27T10:00:00Z",
          taskName: "Internal",
        },
        presets: [
          {
            id: "0182cc10-54d1-7c35-b4f3-e93bb4c0b100",
            workspaceId: "202",
            description: hostilePresetLabel,
            projectId: "303",
            taskId: "404",
            tagIds: ["505"],
            tags: ["$(still-display-data)"],
            billable: true,
            projectColor: null,
            projectName: "R&D",
            taskName: "PR review",
            lastUsedAt: "2026-08-27T09:00:00Z",
          },
        ],
      }),
      "2026-08-27T11:00:05Z",
    );

    expect(view.current).toEqual({
      elapsed: "01:00:05",
      label: hostileCurrentLabel,
      context: "Internal",
      markerColor: "#A1b2C3",
      markerVisible: true,
    });
    expect(view.presets).toEqual([
      {
        id: "0182cc10-54d1-7c35-b4f3-e93bb4c0b100",
        label: hostilePresetLabel,
        context: "R&D · PR review",
        markerColor: "#bfa894",
        markerVisible: true,
      },
    ]);
    if (view.current === null) {
      throw new Error("Expected a projected current entry");
    }
    expectOnlyNonNullPrimitives(view.current);
    view.presets.forEach(expectOnlyNonNullPrimitives);
  });

  it.each([
    { omitted: 0, omittedLabel: "", countLabel: "0 entries" },
    { omitted: 1, omittedLabel: "1 earlier entry not shown", countLabel: "1 entry" },
    { omitted: 3, omittedLabel: "3 earlier entries not shown", countLabel: "3 entries" },
  ])(
    "renders omitted-entry copy for $omitted hidden rows",
    ({ omitted, omittedLabel, countLabel }) => {
      const view = drawerView(
        snapshot({
          status: "idle",
          current: null,
          currentContributesToToday: false,
          todayEntries: [],
          todayEntryCount: omitted,
          todayEntriesOmitted: omitted,
          month: {
            availability: "ready",
            partial: false,
            key: "2026-08",
            completedSeconds: 7_200,
            currentContributes: false,
            synchronizedAt: "2026-08-27T11:00:00Z",
          },
        }),
      );

      expect(view.todayEntriesOmitted).toBe(omitted);
      expect(view.todayEntriesOmittedLabel).toBe(omittedLabel);
      expect(view.todayEntryCount).toBe(omitted);
      expect(view.todayEntryCountLabel).toBe(countLabel);
    },
  );

  it.each([
    {
      name: "unavailable",
      month: {
        availability: "unavailable" as const,
        partial: false,
        key: null,
        completedSeconds: 282_240,
        currentContributes: false,
        synchronizedAt: null,
      },
      expected: { availability: "unavailable", value: "—", cue: "" },
    },
    {
      name: "ready exact",
      month: {
        availability: "ready" as const,
        partial: false,
        key: "2026-08",
        completedSeconds: 282_240,
        currentContributes: false,
        synchronizedAt: "2026-08-27T11:00:00Z",
      },
      expected: { availability: "ready", value: "78h 24m", cue: "" },
    },
    {
      name: "ready partial",
      month: {
        availability: "ready" as const,
        partial: true,
        key: "2026-08",
        completedSeconds: 282_240,
        currentContributes: false,
        synchronizedAt: "2026-08-27T11:00:00Z",
      },
      expected: { availability: "ready", value: "≥ 78h 24m", cue: "partial" },
    },
    {
      name: "stale exact",
      month: {
        availability: "stale" as const,
        partial: false,
        key: "2026-08",
        completedSeconds: 282_240,
        currentContributes: false,
        synchronizedAt: "2026-08-27T11:00:00Z",
      },
      expected: { availability: "stale", value: "78h 24m", cue: "stale" },
    },
    {
      name: "stale partial",
      month: {
        availability: "stale" as const,
        partial: true,
        key: "2026-08",
        completedSeconds: 282_240,
        currentContributes: false,
        synchronizedAt: "2026-08-27T11:00:00Z",
      },
      expected: { availability: "stale", value: "≥ 78h 24m", cue: "partial · stale" },
    },
  ])("renders $name month data", ({ month, expected }) => {
    expect(drawerView(snapshot({ month })).month).toEqual(expected);
  });

  it("provides pending and actionable error copy", () => {
    expect(drawerView(snapshot({ pending: "stopping", error: "state_unconfirmed" }))).toMatchObject(
      { pending: "Stopping…", error: "Timer state could not be confirmed" },
    );
    expect(
      drawerView(
        snapshot({
          status: "offline",
          connection: "offline",
          current: null,
          pending: null,
          error: "daemon_unavailable",
        }),
      ),
    ).toMatchObject({ current: null, error: "Toggl daemon unavailable" });
    expect(drawerView(snapshot({ error: "command_busy" }))).toMatchObject({
      error: "Another Toggl command is still running",
    });
  });
});
