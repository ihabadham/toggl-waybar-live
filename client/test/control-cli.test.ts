import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { type ControlCliDependencies, runControlCli } from "../src/control-cli.js";
import type { ControlSnapshot } from "../src/control-protocol.js";

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => {
    const child = new EventEmitter() as EventEmitter & { unref(): void };
    child.unref = vi.fn();
    queueMicrotask(() => child.emit("spawn"));
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
      projectId: null,
      projectName: "Internal",
      start: "2026-08-27T10:00:00Z",
    },
    completedTodaySeconds: 3_600,
    currentContributesToToday: true,
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
      stdio: "ignore",
    });
    expect(stderr).toEqual([]);
  });

  it("reports command failures only on stderr", async () => {
    const { dependencies, stderr, stdout } = outputDependencies({
      send: async () => result("failed", "request_failed"),
    });
    expect(await runControlCli(["stop"], dependencies)).toBe(1);
    expect(stderr.join("")).toContain("request_failed");
    expect(stdout).toEqual([]);
  });

  it("writes watch NDJSON immediately and ticks locally once per second", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T11:00:00Z"));
    let finish: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const { dependencies, stdout, stderr } = outputDependencies({
      watch: (emit) => {
        emit(snapshot());
        return { done, stop: () => finish?.() };
      },
    });

    const running = runControlCli(["watch"], dependencies);
    expect(stdout).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stdout).toHaveLength(2);
    expect(JSON.parse(stdout[0] ?? "").current.elapsed).toBe("01:00:00");
    expect(JSON.parse(stdout[1] ?? "").current.elapsed).toBe("01:00:01");
    finish?.();
    await expect(running).resolves.toBe(0);
    expect(stderr).toEqual([]);
    vi.useRealTimers();
  });

  it("coalesces watch snapshots and ticks while stdout is backpressured", async () => {
    vi.useFakeTimers();
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
    });
    finish?.();
    await expect(running).resolves.toBe(0);
    vi.useRealTimers();
  });
});
