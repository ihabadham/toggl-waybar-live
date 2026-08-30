import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type ControlClientError,
  sendControlCommand,
  type WatchController,
  watchControlSnapshots,
} from "../src/control-client.js";
import type { ControlSnapshot } from "../src/control-protocol.js";
import {
  type ControlProvider,
  type ControlServerController,
  startControlServer,
} from "../src/control-server.js";
import {
  commandResponseTimeoutMilliseconds,
  maximumInteractiveTogglRequests,
  togglRequestDeadlineMilliseconds,
} from "../src/control-timing.js";

const directories: string[] = [];
const controlServers: ControlServerController[] = [];
const rawServers: Server[] = [];
const rawSockets = new Set<Socket>();
const watches: WatchController[] = [];

function snapshot(): ControlSnapshot {
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
  };
}

function provider(): ControlProvider {
  return {
    handle: async () => ({
      version: 1,
      type: "result",
      outcome: "already_idle",
      error: null,
    }),
    snapshot,
    subscribe: () => () => undefined,
  };
}

async function socketPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "toggl-control-client-"));
  directories.push(directory);
  return join(directory, "runtime", "control.sock");
}

afterEach(async () => {
  for (const watch of watches.splice(0)) {
    watch.stop();
  }
  await Promise.all(controlServers.splice(0).map((server) => server.close()));
  await Promise.all(
    rawServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          for (const socket of rawSockets) {
            socket.destroy();
          }
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("control client", () => {
  it("allows more time than one worst-case interactive operation", () => {
    expect(commandResponseTimeoutMilliseconds).toBeGreaterThan(
      togglRequestDeadlineMilliseconds * maximumInteractiveTogglRequests,
    );
  });

  it("sends a one-shot command and fails promptly when the daemon is absent", async () => {
    const path = await socketPath();
    const server = await startControlServer({ path, provider: provider() });
    controlServers.push(server);

    await expect(sendControlCommand({ version: 1, type: "stop" }, { path })).resolves.toMatchObject(
      {
        outcome: "already_idle",
      },
    );
    await server.close();
    controlServers.splice(controlServers.indexOf(server), 1);
    await expect(
      sendControlCommand({ version: 1, type: "stop" }, { path, timeoutMilliseconds: 100 }),
    ).rejects.toMatchObject({ code: "daemon_unavailable" } satisfies Partial<ControlClientError>);
  });

  it("rejects malformed or multiple command response frames", async () => {
    const path = await socketPath();
    await mkdir(join(path, ".."), { recursive: true });
    const server = createServer((socket) => {
      rawSockets.add(socket);
      socket.once("close", () => rawSockets.delete(socket));
      socket.once("data", () => {
        socket.write("{}\n{}\n");
        setImmediate(() => socket.end());
      });
    });
    rawServers.push(server);
    await new Promise<void>((resolve) => server.listen(path, resolve));

    await expect(sendControlCommand({ version: 1, type: "toggle" }, { path })).rejects.toThrow(
      "multiple responses",
    );
  });

  it("waits for a delayed mutation result after the socket connects", async () => {
    const path = await socketPath();
    await mkdir(join(path, ".."), { recursive: true });
    const server = createServer((socket) => {
      rawSockets.add(socket);
      socket.once("close", () => rawSockets.delete(socket));
      socket.once("data", () => {
        setTimeout(
          () =>
            socket.end(
              `${JSON.stringify({ version: 1, type: "result", outcome: "stopped", error: null })}\n`,
            ),
          2_100,
        );
      });
    });
    rawServers.push(server);
    await new Promise<void>((resolve) => server.listen(path, resolve));

    await expect(sendControlCommand({ version: 1, type: "stop" }, { path })).resolves.toMatchObject(
      { outcome: "stopped" },
    );
  }, 4_000);

  it("bounds the full command exchange when a connected daemon never responds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const path = await socketPath();
      await mkdir(join(path, ".."), { recursive: true });
      let acknowledgeRequest!: () => void;
      const requestReceived = new Promise<void>((resolve) => {
        acknowledgeRequest = resolve;
      });
      const server = createServer((socket) => {
        rawSockets.add(socket);
        socket.once("close", () => rawSockets.delete(socket));
        socket.once("data", acknowledgeRequest);
      });
      rawServers.push(server);
      await new Promise<void>((resolve) => server.listen(path, resolve));

      const command = sendControlCommand(
        { version: 1, type: "stop" },
        { path, timeoutMilliseconds: 100 },
      ).then(
        () => null,
        (error: ControlClientError) => error,
      );
      await requestReceived;
      await vi.advanceTimersByTimeAsync(100);

      await expect(command).resolves.toMatchObject({ code: "request_failed" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits one unavailable snapshot per disconnect and reconnects forever", async () => {
    const path = await socketPath();
    const received: ControlSnapshot[] = [];
    const watch = watchControlSnapshots((value) => received.push(value), {
      path,
      reconnectDelay: () => 5,
      now: () => new Date("2026-08-27T12:00:00Z"),
    });
    watches.push(watch);

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]?.error).toBe("daemon_unavailable");
    expect(received[0]).toMatchObject({
      timezone: null,
      todayEntries: [],
      todayEntryCount: 0,
      todayEntriesOmitted: 0,
      month: { availability: "unavailable", key: null },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received).toHaveLength(1);

    const server = await startControlServer({ path, provider: provider() });
    controlServers.push(server);
    await vi.waitFor(() => expect(received.some((value) => value.error === null)).toBe(true));

    await server.close();
    controlServers.splice(controlServers.indexOf(server), 1);
    await vi.waitFor(() =>
      expect(received.filter((value) => value.error === "daemon_unavailable")).toHaveLength(2),
    );
  });

  it("disconnects before accumulating an oversized watch response", async () => {
    const path = await socketPath();
    await mkdir(join(path, ".."), { recursive: true });
    const server = createServer((socket) => {
      rawSockets.add(socket);
      socket.once("close", () => rawSockets.delete(socket));
      socket.once("data", () => socket.write(Buffer.alloc(64 * 1_024 + 1, 0x78)));
    });
    rawServers.push(server);
    await new Promise<void>((resolve) => server.listen(path, resolve));
    const received: ControlSnapshot[] = [];
    const watch = watchControlSnapshots((value) => received.push(value), {
      path,
      reconnectDelay: () => 60_000,
    });
    watches.push(watch);

    await vi.waitFor(() => expect(received[0]?.error).toBe("daemon_unavailable"));
    watch.stop();
    await expect(watch.done).resolves.toBeUndefined();
  });

  it("cancels a pending reconnect and resolves done when watch stops", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const path = await socketPath();
      const received: ControlSnapshot[] = [];
      const watch = watchControlSnapshots((value) => received.push(value), {
        path,
        reconnectDelay: () => 60_000,
      });
      watches.push(watch);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(received[0]?.error).toBe("daemon_unavailable");
      expect(vi.getTimerCount()).toBe(1);
      watch.stop();

      await expect(watch.done).resolves.toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(received).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
