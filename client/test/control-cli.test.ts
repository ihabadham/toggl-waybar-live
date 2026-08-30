import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { type ControlCliDependencies, runControlCli } from "../src/control-cli.js";
import type { ControlSnapshot } from "../src/control-protocol.js";

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => {
    const child = new EventEmitter() as EventEmitter & {
      kill(signal?: NodeJS.Signals): boolean;
      stderr: PassThrough;
    };
    child.kill = vi.fn(() => true);
    child.stderr = new PassThrough();
    queueMicrotask(() => child.emit("close", 0));
    return child;
  });
});

function result(
  outcome: "stopped" | "drawer_required" | "failed" = "stopped",
  error: "request_failed" | null = null,
) {
  return { version: 1 as const, type: "result" as const, outcome, error };
}

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
    presets: [],
    generatedAt: "2026-08-27T11:00:00Z",
    lastSynchronizedAt: "2026-08-27T11:00:00Z",
    error: null,
    ...overrides,
  };
}

function outputDependencies(overrides: ControlCliDependencies = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    dependencies: {
      writeOutput: (value: string) => stdout.push(value),
      writeError: (value: string) => stderr.push(value),
      ...overrides,
    },
    stdout,
    stderr,
  };
}

describe("control CLI", () => {
  it.each([
    [[], 2],
    [["unknown"], 2],
    [["toggle", "extra"], 2],
    [["resume", "not-a-uuid"], 2],
  ])("rejects invalid grammar %j", async (arguments_, expected) => {
    const { dependencies, stderr, stdout } = outputDependencies();
    expect(await runControlCli(arguments_, dependencies)).toBe(expected);
    expect(stderr.join("")).toContain("Usage:");
    expect(stdout).toEqual([]);
  });

  it("maps exact commands without writing command output to stdout", async () => {
    const send = vi.fn(async (_request: unknown) => result());
    const { dependencies, stdout, stderr } = outputDependencies({ send });
    const id = "0182cc10-54d1-7c35-b4f3-e93bb4c0b100";

    expect(await runControlCli(["toggle"], dependencies)).toBe(0);
    expect(await runControlCli(["stop"], dependencies)).toBe(0);
    expect(await runControlCli(["resume"], dependencies)).toBe(0);
    expect(await runControlCli(["resume", id], dependencies)).toBe(0);
    expect(send.mock.calls.map(([request]) => request)).toEqual([
      { version: 1, type: "toggle" },
      { version: 1, type: "stop" },
      { version: 1, type: "resume", presetId: null },
      { version: 1, type: "resume", presetId: id },
    ]);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([]);
  });

  it("opens the fixed drawer command only when toggle requires selection", async () => {
    const invokeDrawer = vi.fn(async () => true);
    const { dependencies, stderr } = outputDependencies({
      send: async () => result("drawer_required"),
      invokeDrawer,
    });
    expect(await runControlCli(["toggle"], dependencies)).toBe(0);
    expect(invokeDrawer).toHaveBeenCalledOnce();
    expect(stderr).toEqual([]);

    invokeDrawer.mockResolvedValue(false);
    expect(await runControlCli(["toggle"], dependencies)).toBe(1);
    expect(stderr.join("")).toContain("No resumable activity exists");

    invokeDrawer.mockClear();
    expect(await runControlCli(["resume"], dependencies)).toBe(1);
    expect(invokeDrawer).not.toHaveBeenCalled();
  });

  it("spawns only the production drawer executable with fixed argv and no shell", async () => {
    const { dependencies, stderr } = outputDependencies({
      send: async () => result("drawer_required"),
    });

    expect(await runControlCli(["toggle"], dependencies)).toBe(0);
    expect(spawnMock).toHaveBeenCalledWith("toggl-waybar-drawer", ["open"], {
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
    });
    expect(stderr).toEqual([]);
  });

  it("waits for the drawer command and reports its stderr on failure", async () => {
    spawnMock.mockImplementationOnce(() => {
      const child = new EventEmitter() as EventEmitter & {
        kill(signal?: NodeJS.Signals): boolean;
        stderr: PassThrough;
      };
      child.kill = vi.fn(() => true);
      child.stderr = new PassThrough();
      queueMicrotask(() => {
        child.stderr.end("Unable to open the Toggl drawer\n");
        child.emit("close", 1);
      });
      return child;
    });
    const { dependencies, stderr } = outputDependencies({
      send: async () => result("drawer_required"),
    });

    expect(await runControlCli(["toggle"], dependencies)).toBe(1);
    expect(stderr.join("")).toContain("Unable to open the Toggl drawer");
  });

  it("kills a drawer command that does not finish", async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter() as EventEmitter & {
        kill(signal?: NodeJS.Signals): boolean;
        stderr: PassThrough;
      };
      child.kill = vi.fn(() => true);
      child.stderr = new PassThrough();
      spawnMock.mockReturnValueOnce(child);
      const { dependencies, stderr } = outputDependencies({
        send: async () => result("drawer_required"),
      });

      const running = runControlCli(["toggle"], dependencies);
      await vi.advanceTimersByTimeAsync(30_000);

      await expect(running).resolves.toBe(1);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      expect(stderr.join("")).toContain("Toggl drawer command timed out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports command failures only on stderr", async () => {
    const { dependencies, stderr, stdout } = outputDependencies({
      send: async () => result("failed", "request_failed"),
    });
    expect(await runControlCli(["stop"], dependencies)).toBe(1);
    expect(stderr.join("")).toContain("request_failed");
    expect(stdout).toEqual([]);
  });

  it("projects every live duration from one watch subscription without sending commands", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-27T10:59:59Z"));
      let finish: (() => void) | undefined;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const watch = vi.fn((emit: (value: ControlSnapshot) => void) => {
        emit(snapshot());
        return { done, stop: () => finish?.() };
      });
      const send = vi.fn(async (_request: unknown) => result());
      const { dependencies, stdout, stderr } = outputDependencies({ send, watch });

      const running = runControlCli(["watch"], dependencies);
      expect(stdout).toHaveLength(1);
      expect(JSON.parse(stdout[0] ?? "")).toMatchObject({
        current: { elapsed: "00:59:59" },
        today: "01:59:59",
        todayEntries: [{ id: "101", duration: "00:59:59", running: true }],
        month: { value: "2h 59m" },
      });

      await vi.advanceTimersByTimeAsync(1_000);

      expect(stdout).toHaveLength(2);
      expect(JSON.parse(stdout[1] ?? "")).toMatchObject({
        current: { elapsed: "01:00:00" },
        today: "02:00:00",
        todayEntries: [{ id: "101", duration: "01:00:00", running: true }],
        month: { value: "3h 00m" },
      });
      expect(watch).toHaveBeenCalledOnce();
      expect(send).not.toHaveBeenCalled();
      finish?.();
      await expect(running).resolves.toBe(0);
      expect(stderr).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces watch snapshots and ticks while stdout is backpressured", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-27T11:00:00Z"));
      let finish: (() => void) | undefined;
      let emit: ((value: ControlSnapshot) => void) | undefined;
      let drain: (() => void) | undefined;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const writes: string[] = [];
      const output = {
        write: vi.fn((value: string) => {
          writes.push(value);
          return writes.length > 1;
        }),
        once: vi.fn((_event: "drain", listener: () => void) => {
          drain = listener;
        }),
      };
      const { dependencies } = outputDependencies({
        output,
        watch: (listener) => {
          emit = listener;
          listener(snapshot());
          return { done, stop: () => finish?.() };
        },
      });

      const running = runControlCli(["watch"], dependencies);
      expect(writes).toHaveLength(1);
      for (let index = 0; index < 100; index += 1) {
        emit?.(snapshot({ completedTodaySeconds: index }));
      }
      await vi.advanceTimersByTimeAsync(10_000);
      expect(writes).toHaveLength(1);
      expect(output.once).toHaveBeenCalledOnce();

      drain?.();
      expect(writes).toHaveLength(2);
      expect(JSON.parse(writes[1] ?? "")).toMatchObject({
        current: { elapsed: "01:00:10" },
        today: "01:01:49",
        todayEntries: [{ id: "101", duration: "01:00:10", running: true }],
        month: { value: "3h 00m" },
      });
      finish?.();
      await expect(running).resolves.toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
