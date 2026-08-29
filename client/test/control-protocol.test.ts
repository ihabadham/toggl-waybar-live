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
  projectName: "Internal",
  taskName: null,
  lastUsedAt: "2026-08-27T10:00:00Z",
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
        completedTodaySeconds: 0,
        currentContributesToToday: false,
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
    expect(() =>
      commandResultSchema.parse({
        version: 1,
        type: "result",
        outcome: "retried",
        error: null,
      }),
    ).toThrow();

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
        projectName: "Internal",
        start: "2026-08-27T10:00:00Z",
      },
      completedTodaySeconds: 3600,
      currentContributesToToday: true,
      presets: [preset],
      generatedAt: "2026-08-27T12:00:00Z",
      lastSynchronizedAt: "2026-08-27T11:00:00Z",
      error: null,
    };
    expect(controlSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(() => controlSnapshotSchema.parse({ ...snapshot, confidence: "probably" })).toThrow();
    expect(() => controlSnapshotSchema.parse({ ...snapshot, extra: true })).toThrow();
  });
});
