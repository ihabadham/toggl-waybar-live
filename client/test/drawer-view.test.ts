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
      projectName: "Internal",
      start: "2026-08-27T10:00:00Z",
    },
    completedTodaySeconds: 3_600,
    currentContributesToToday: true,
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

describe("drawer view", () => {
  it("formats live elapsed and today durations from the latest snapshot", () => {
    const view = drawerView(snapshot(), "2026-08-27T11:00:05Z");

    expect(view.current).toEqual({ elapsed: "01:00:05", label: "Review", project: "Internal" });
    expect(view.today).toBe("02:00:05");
  });

  it("keeps hostile preset labels as separate display data", () => {
    expect(drawerView(snapshot()).presets).toEqual([
      {
        id: "0182cc10-54d1-7c35-b4f3-e93bb4c0b100",
        label: "$(touch /tmp/not-a-command)",
        project: "R&D",
        task: "PR review",
        tags: ["client; shutdown now"],
        billable: true,
      },
    ]);
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
  });
});
