import { env, exports as workerExports } from "cloudflare:workers";
import type { NormalizedEntry, NormalizedEvent, RelayMessage } from "@toggl-waybar-live/shared";
import { describe, expect, it } from "vitest";

import type { WorkerEnv } from "../src/env.js";
import { type RelayState, reduceRelayState } from "../src/relay-object.js";

const emptyState: RelayState = { cursor: null, snapshot: null };

interface EventOverrides {
  callbackUrl?: string;
  deliveredAt?: string;
  entry?: NormalizedEntry;
  eventCreatedAt?: string;
  eventId?: string;
}

function runningEntry(overrides: Partial<NormalizedEntry> = {}): NormalizedEntry {
  return {
    id: "101",
    workspaceId: "202",
    userId: "303",
    projectId: "404",
    projectName: "Internal",
    description: "Review",
    start: "2026-08-27T18:30:00Z",
    stop: null,
    durationSeconds: null,
    ...overrides,
  };
}

function runningEvent(overrides: EventOverrides = {}): NormalizedEvent {
  return {
    action: "created",
    eventId: "10",
    eventCreatedAt: "2026-08-27T19:00:00Z",
    deliveredAt: "2026-08-27T19:00:01Z",
    callbackUrl: "https://relay.example/webhooks/toggl",
    entry: runningEntry(),
    ...overrides,
  };
}

function stoppedEvent(overrides: EventOverrides = {}): NormalizedEvent {
  return {
    action: "updated",
    eventId: "11",
    eventCreatedAt: "2026-08-27T19:05:00Z",
    deliveredAt: "2026-08-27T19:05:01Z",
    callbackUrl: "https://relay.example/webhooks/toggl",
    entry: runningEntry({
      stop: "2026-08-27T19:05:00Z",
      durationSeconds: 2_100,
    }),
    ...overrides,
  };
}

async function connect(token = "test-relay-token"): Promise<WebSocket> {
  const response = await workerExports.default.fetch(
    new Request("https://relay.example/ws", {
      headers: {
        authorization: `Bearer ${token}`,
        upgrade: "websocket",
      },
    }),
  );
  expect(response.status).toBe(101);
  expect(response.webSocket).not.toBeNull();
  const socket = response.webSocket as WebSocket;
  socket.accept();
  return socket;
}

function receive(socket: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    socket.addEventListener("message", (message) => resolve(String(message.data)), { once: true });
  });
}

function receiveMany(socket: WebSocket, count: number): Promise<string[]> {
  return new Promise((resolve) => {
    const messages: string[] = [];
    const listener = (message: MessageEvent) => {
      messages.push(String(message.data));
      if (messages.length === count) {
        socket.removeEventListener("message", listener);
        resolve(messages);
      }
    };
    socket.addEventListener("message", listener);
  });
}

describe("relay state reducer", () => {
  it("creates a running snapshot and change from a start", () => {
    const transition = reduceRelayState(emptyState, runningEvent());

    expect(transition?.state.snapshot).toEqual({
      status: "running",
      entryId: "101",
      workspaceId: "202",
      projectId: "404",
      description: "Review",
      start: "2026-08-27T18:30:00Z",
      eventId: "10",
      eventCreatedAt: "2026-08-27T19:00:00Z",
    });
    expect(transition?.messages.map((message) => message.type)).toEqual([
      "snapshot",
      "entry.changed",
    ]);
  });

  it("scrubs a stopped current entry from the persisted snapshot", () => {
    const running = reduceRelayState(emptyState, runningEvent());
    const stopped = reduceRelayState(running?.state as RelayState, stoppedEvent());

    expect(stopped?.state.snapshot).toEqual({
      status: "idle",
      updatedAt: "2026-08-27T19:05:00Z",
      eventId: "11",
      eventCreatedAt: "2026-08-27T19:05:00Z",
    });
    expect(JSON.stringify(stopped?.state)).not.toContain("Review");
    expect(stopped?.messages[1]).toMatchObject({
      type: "entry.changed",
      change: { action: "updated", entry: { durationSeconds: 2_100 } },
    });
  });

  it("scrubs a deleted current entry from the persisted snapshot", () => {
    const running = reduceRelayState(emptyState, runningEvent());
    const deleted: NormalizedEvent = {
      action: "deleted",
      entry: { id: "101", workspaceId: "202", userId: "303" },
      eventId: "11",
      eventCreatedAt: "2026-08-27T19:05:00Z",
      deliveredAt: "2026-08-27T19:05:01Z",
      callbackUrl: "https://relay.example/webhooks/toggl",
    };
    const transition = reduceRelayState(running?.state as RelayState, deleted);

    expect(transition?.state.snapshot?.status).toBe("idle");
    expect(JSON.stringify(transition?.state)).not.toContain("Review");
  });

  it("keeps the running snapshot for a completed non-current entry", () => {
    const running = reduceRelayState(emptyState, runningEvent());
    const unrelated = stoppedEvent({
      eventId: "12",
      eventCreatedAt: "2026-08-27T19:06:00Z",
      entry: runningEntry({
        id: "999",
        stop: "2026-08-27T19:05:00Z",
        durationSeconds: 2_100,
      }),
    });
    const transition = reduceRelayState(running?.state as RelayState, unrelated);

    expect(transition?.state.snapshot).toBe(running?.state.snapshot);
    expect(transition?.state.cursor?.eventId).toBe("12");
    expect(transition?.messages.map((message) => message.type)).toEqual(["entry.changed"]);
  });

  it("ignores duplicate and older events", () => {
    const running = reduceRelayState(emptyState, runningEvent());

    expect(reduceRelayState(running?.state as RelayState, runningEvent())).toBeNull();
    expect(
      reduceRelayState(
        running?.state as RelayState,
        runningEvent({ eventId: "999", eventCreatedAt: "2026-08-27T18:59:59Z" }),
      ),
    ).toBeNull();
  });

  it("orders equal timestamps by arbitrary-size decimal event ID", () => {
    const first = reduceRelayState(emptyState, runningEvent({ eventId: "90071992547409930" }));

    expect(
      reduceRelayState(first?.state as RelayState, runningEvent({ eventId: "90071992547409929" })),
    ).toBeNull();
    expect(
      reduceRelayState(first?.state as RelayState, runningEvent({ eventId: "90071992547409931" })),
    ).not.toBeNull();
  });
});

describe("relay Durable Object", () => {
  it("rejects an unauthorized WebSocket before forwarding", async () => {
    const response = await workerExports.default.fetch(
      new Request("https://relay.example/ws", {
        headers: { authorization: "Bearer wrong", upgrade: "websocket" },
      }),
    );

    expect(response.status).toBe(401);
  });

  it("persists snapshots, broadcasts changes, reconnects, and auto-responds to ping", async () => {
    const workerEnv = env as unknown as WorkerEnv;
    const relay = workerEnv.RELAY.getByName("primary");
    const firstSocket = await connect();
    const initialMessages: string[] = [];
    firstSocket.addEventListener("message", (message) => {
      initialMessages.push(String(message.data));
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(initialMessages).toEqual([]);

    const startMessagesPromise = receiveMany(firstSocket, 2);
    await relay.applyEvent(runningEvent());
    const startMessages = (await startMessagesPromise).map(
      (message) => JSON.parse(message) as RelayMessage,
    );
    const snapshot = startMessages[0];
    expect(snapshot).toMatchObject({
      type: "snapshot",
      snapshot: { status: "running", entryId: "101" },
    });
    expect(startMessages[1]).toMatchObject({
      type: "entry.changed",
      change: { action: "created", entry: { id: "101" } },
    });

    const reconnect = await connect();
    expect(JSON.parse(await receive(reconnect))).toMatchObject({
      type: "snapshot",
      snapshot: { status: "running", entryId: "101" },
    });

    const pongPromise = receive(reconnect);
    reconnect.send("ping");
    expect(await pongPromise).toBe("pong");

    const stopMessagesPromise = receiveMany(reconnect, 2);
    await relay.applyEvent(stoppedEvent());
    const stopMessages = (await stopMessagesPromise).map(
      (message) => JSON.parse(message) as RelayMessage,
    );
    expect(stopMessages[0]).toMatchObject({
      type: "snapshot",
      snapshot: { status: "idle" },
    });
    expect(stopMessages[1]).toMatchObject({
      type: "entry.changed",
      change: { action: "updated", entry: { durationSeconds: 2_100 } },
    });

    const idleReconnect = await connect();
    expect(JSON.parse(await receive(idleReconnect))).toMatchObject({
      type: "snapshot",
      snapshot: { status: "idle" },
    });

    firstSocket.close(1000, "done");
    reconnect.close(1000, "done");
    idleReconnect.close(1000, "done");
  });
});
