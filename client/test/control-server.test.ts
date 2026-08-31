import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ControlSnapshot } from "../src/control-protocol.js";
import {
  type ControlProvider,
  type ControlServerController,
  startControlServer,
} from "../src/control-server.js";

const directories: string[] = [];
const servers: ControlServerController[] = [];
const children: ChildProcess[] = [];

function snapshot(overrides: Partial<ControlSnapshot> = {}): ControlSnapshot {
  return {
    version: 1,
    type: "snapshot",
    status: "idle",
    connection: "connected",
    confidence: "confirmed",
    pending: null,
    current: null,
    timezone: "Africa/Cairo",
    completedTodaySeconds: 60,
    currentContributesToToday: false,
    todayEntries: [],
    todayEntryCount: 0,
    todayEntriesOmitted: 0,
    month: {
      availability: "ready",
      partial: false,
      key: "2026-08",
      completedSeconds: 60,
      currentContributes: false,
      synchronizedAt: "2026-08-27T11:00:00Z",
    },
    presets: [],
    generatedAt: "2026-08-27T11:00:00Z",
    lastSynchronizedAt: "2026-08-27T11:00:00Z",
    error: null,
    ...overrides,
  };
}

function provider(): ControlProvider & {
  commit(value: ControlSnapshot): void;
  handled: ReturnType<typeof vi.fn>;
  subscribers: Set<(value: ControlSnapshot) => void>;
} {
  let current = snapshot();
  const subscribers = new Set<(value: ControlSnapshot) => void>();
  const handled = vi.fn(async () => ({
    version: 1 as const,
    type: "result" as const,
    outcome: "already_idle" as const,
    error: null,
  }));
  return {
    handled,
    subscribers,
    handle: handled,
    snapshot: () => current,
    subscribe: (subscriber) => {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
    commit: (value) => {
      current = value;
      for (const subscriber of subscribers) {
        subscriber(value);
      }
    },
  };
}

async function socketPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "toggl-control-server-"));
  directories.push(directory);
  return join(directory, "runtime", "control.sock");
}

function exchange(path: string, chunks: Array<string | Buffer>, end = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let output = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      for (const chunk of chunks) {
        socket.write(chunk);
      }
      if (end) {
        socket.end();
      }
    });
    socket.on("data", (chunk: string) => (output += chunk));
    socket.once("error", reject);
    socket.once("close", () => resolve(output));
  });
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
  }
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("control server", () => {
  it("accepts a partial command frame and returns exactly one result", async () => {
    const path = await socketPath();
    const source = provider();
    servers.push(await startControlServer({ path, provider: source }));

    const output = await exchange(path, ['{"version":1,"type":"st', 'op"}\n']);

    expect(output.trim().split("\n")).toEqual([
      JSON.stringify({ version: 1, type: "result", outcome: "already_idle", error: null }),
    ]);
    expect(source.handled).toHaveBeenCalledOnce();
  });

  it.each([
    ["malformed", ["not-json\n"], false],
    ["missing newline", ['{"version":1,"type":"stop"}'], true],
    ["multiple frames", ['{"version":1,"type":"stop"}\n{}\n'], false],
    ["bytes after a frame", ['{"version":1,"type":"stop"}\nx'], false],
    ["oversized", [Buffer.alloc(64 * 1_024 + 1, 0x78)], false],
  ])("rejects %s input without dispatch", async (_label, chunks, end) => {
    const path = await socketPath();
    const source = provider();
    servers.push(await startControlServer({ path, provider: source }));

    expect(await exchange(path, chunks, end)).toBe("");
    expect(source.handled).not.toHaveBeenCalled();
  });

  it("publishes an immediate watch snapshot and later commits until disconnect", async () => {
    const path = await socketPath();
    const source = provider();
    servers.push(await startControlServer({ path, provider: source }));
    const socket = createConnection(path);
    let output = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write('{"version":1,"type":"watch"}\n'));
    socket.on("data", (chunk: string) => (output += chunk));

    await vi.waitFor(() => expect(output).not.toBe(""));
    expect(output.trim().split("\n")).toHaveLength(1);
    expect(source.subscribers.size).toBe(1);
    source.commit(snapshot({ completedTodaySeconds: 120 }));
    await vi.waitFor(() => expect(output.trim().split("\n")).toHaveLength(2));
    socket.destroy();
    await vi.waitFor(() => expect(source.subscribers.size).toBe(0));
  });

  it("disconnects a watcher instead of buffering after write backpressure", async () => {
    const path = await socketPath();
    const source = provider();
    servers.push(await startControlServer({ path, provider: source }));
    const socket = createConnection(path);
    socket.on("error", () => undefined);
    socket.once("connect", () => {
      socket.write('{"version":1,"type":"watch"}\n');
      socket.pause();
    });
    await vi.waitFor(() => expect(source.subscribers.size).toBe(1));

    for (let index = 0; index < 2_000 && source.subscribers.size > 0; index += 1) {
      source.commit(
        snapshot({
          error: "request_failed",
          current: {
            id: "101",
            workspaceId: "202",
            description: `${index}:${"x".repeat(48_000)}`,
            projectId: null,
            projectColor: null,
            projectName: null,
            start: "2026-08-27T10:00:00Z",
            taskName: null,
          },
          status: "running",
        }),
      );
    }
    expect(source.subscribers.size).toBe(0);
    socket.destroy();
  });

  it("creates private runtime paths and refuses collisions or a live daemon", async () => {
    const path = await socketPath();
    const source = provider();
    const first = await startControlServer({ path, provider: source });
    servers.push(first);

    expect((await stat(join(path, ".."))).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(startControlServer({ path, provider: source })).rejects.toThrow("already running");

    await first.close();
    servers.splice(servers.indexOf(first), 1);
    await writeFile(path, "collision", "utf8");
    await expect(startControlServer({ path, provider: source })).rejects.toThrow("collide");
    await rm(path);
    await symlink(join(path, "..", "missing"), path);
    await expect(startControlServer({ path, provider: source })).rejects.toThrow("collide");
  });

  it("keeps the private staging socket within Unix path limits", async () => {
    const directory = await mkdtemp(join(tmpdir(), `toggl-${"x".repeat(50)}-`));
    directories.push(directory);
    const path = join(directory, "runtime", "control.sock");

    const server = await startControlServer({ path, provider: provider() });
    servers.push(server);

    expect((await stat(path)).isSocket()).toBe(true);
  });

  it("recovers a stale socket left by a dead daemon", async () => {
    const path = await socketPath();
    await mkdir(join(path, ".."), { recursive: true });
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import net from "node:net"; const server=net.createServer(); server.listen(process.argv[1],()=>process.stdout.write("ready\\n"));',
        path,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    children.push(child);
    await new Promise<void>((resolve) => child.stdout?.once("data", () => resolve()));
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));

    const server = await startControlServer({ path, provider: provider() });
    servers.push(server);
    expect((await stat(path)).isSocket()).toBe(true);
  });

  it("does not remove a replacement socket during shutdown", async () => {
    const path = await socketPath();
    const original = await startControlServer({ path, provider: provider() });
    servers.push(original);
    await rename(path, `${path}.old`);
    const replacement = createServer();
    await new Promise<void>((resolve) => replacement.listen(path, resolve));

    await original.close();
    servers.splice(servers.indexOf(original), 1);
    expect((await stat(path)).isSocket()).toBe(true);

    await new Promise<void>((resolve) => replacement.close(() => resolve()));
  });

  it("does not dispatch a command after shutdown begins", async () => {
    const path = await socketPath();
    const source = provider();
    const server = await startControlServer({ path, provider: source });
    servers.push(server);
    const socket = createConnection(path);
    socket.on("error", () => undefined);
    const socketClosed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.once("connect", () => socket.write('{"version":1,"type":"stop"}\n'));

    const closing = server.close();
    await Promise.all([closing, socketClosed]);
    servers.splice(servers.indexOf(server), 1);

    expect(source.handled).not.toHaveBeenCalled();
  });
});
