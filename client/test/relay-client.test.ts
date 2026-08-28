import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import {
  RelayClient,
  type RelayClientCallbacks,
  type RelaySocketFactory,
  type RelayStaleReason,
  type RelayTimers,
} from "../src/relay-client.js";

interface ScheduledTask {
  callback: () => void;
  cleared: boolean;
  delay: number;
  handle: ReturnType<typeof setTimeout>;
}

class FakeTimers implements RelayTimers {
  readonly tasks: ScheduledTask[] = [];

  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout> {
    const handle = { id: this.tasks.length } as unknown as ReturnType<typeof setTimeout>;
    this.tasks.push({ callback, cleared: false, delay, handle });
    return handle;
  }

  clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    const task = this.tasks.find((candidate) => candidate.handle === handle);
    if (task) {
      task.cleared = true;
    }
  }

  runNext(delay?: number): void {
    const task = this.tasks.find(
      (candidate) => !candidate.cleared && (delay === undefined || candidate.delay === delay),
    );
    if (!task) {
      throw new Error(`No scheduled task for ${String(delay)}`);
    }
    task.cleared = true;
    task.callback();
  }
}

class FakeSocket extends EventEmitter {
  readonly sent: string[] = [];
  closed = false;
  terminated = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.emit("close");
  }

  terminate(): void {
    this.terminated = true;
    this.emit("close");
  }
}

function callbacks(): RelayClientCallbacks & {
  closed: number;
  messages: unknown[];
  opened: number;
  stale: RelayStaleReason[];
} {
  const result = {
    closed: 0,
    messages: [] as unknown[],
    opened: 0,
    stale: [] as RelayStaleReason[],
    onClose: () => {
      result.closed += 1;
    },
    onMessage: (message: unknown) => {
      result.messages.push(message);
    },
    onOpen: () => {
      result.opened += 1;
    },
    onStale: (reason: RelayStaleReason) => {
      result.stale.push(reason);
    },
  };
  return result;
}

function harness(): {
  callbacks: ReturnType<typeof callbacks>;
  client: RelayClient;
  options: Array<{ headers: { Authorization: string } }>;
  sockets: FakeSocket[];
  timers: FakeTimers;
} {
  const sockets: FakeSocket[] = [];
  const options: Array<{ headers: { Authorization: string } }> = [];
  const timers = new FakeTimers();
  const observed = callbacks();
  const socketFactory: RelaySocketFactory = (_url, configuration) => {
    const socket = new FakeSocket();
    sockets.push(socket);
    options.push(configuration);
    return socket;
  };
  const client = new RelayClient({
    url: "wss://relay.example/ws",
    token: "private-relay-token",
    socketFactory,
    timers,
    random: () => 0.5,
    ...observed,
  });
  return { callbacks: observed, client, options, sockets, timers };
}

describe("relay client", () => {
  it("connects with authorization and delivers validated messages", () => {
    const test = harness();
    test.client.start();
    expect(test.options).toEqual([{ headers: { Authorization: "Bearer private-relay-token" } }]);

    test.sockets[0]?.emit("open");
    test.sockets[0]?.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          version: 1,
          type: "snapshot",
          snapshot: {
            status: "idle",
            updatedAt: "2026-08-27T12:00:00Z",
            eventId: "1",
            eventCreatedAt: "2026-08-27T12:00:00Z",
          },
        }),
      ),
    );

    expect(test.callbacks.opened).toBe(1);
    expect(test.callbacks.messages).toHaveLength(1);
  });

  it("marks invalid messages stale without exposing the token", () => {
    const test = harness();
    test.client.start();
    test.sockets[0]?.emit("open");
    test.sockets[0]?.emit("message", Buffer.from("invalid"));

    expect(test.callbacks.stale).toEqual(["invalid_message"]);
    expect(test.sockets[0]?.terminated).toBe(true);
    expect(JSON.stringify(test.callbacks)).not.toContain("private-relay-token");
  });

  it("sends a heartbeat and terminates a socket that misses pong", () => {
    const test = harness();
    test.client.start();
    test.sockets[0]?.emit("open");

    test.timers.runNext(45_000);
    expect(test.sockets[0]?.sent).toEqual(["ping"]);
    test.timers.runNext(15_000);

    expect(test.callbacks.stale).toContain("heartbeat_timeout");
    expect(test.sockets[0]?.terminated).toBe(true);
  });

  it("uses deterministic full-jitter backoff capped at 60 seconds", () => {
    const timers = new FakeTimers();
    const delays: number[] = [];
    const observed = callbacks();
    const client = new RelayClient({
      url: "wss://relay.example/ws",
      token: "token",
      socketFactory: () => {
        throw new Error("connect failed");
      },
      timers: {
        setTimeout: (callback, delay) => {
          delays.push(delay);
          return timers.setTimeout(callback, delay);
        },
        clearTimeout: (handle) => timers.clearTimeout(handle),
      },
      random: () => 0.999,
      ...observed,
    });

    client.start();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      timers.runNext();
    }

    expect(delays.slice(0, 7)).toEqual([999, 1_998, 3_996, 7_992, 15_984, 31_968, 59_940]);
    expect(Math.max(...delays)).toBe(59_940);
  });

  it("clears timers and closes cleanly without reconnecting", () => {
    const test = harness();
    test.client.start();
    test.sockets[0]?.emit("open");
    test.client.stop();

    expect(test.sockets[0]?.closed).toBe(true);
    expect(test.callbacks.closed).toBe(0);
    expect(test.timers.tasks.every((task) => task.cleared)).toBe(true);
    expect(test.sockets).toHaveLength(1);
  });
});
