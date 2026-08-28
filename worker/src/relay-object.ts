import { DurableObject } from "cloudflare:workers";
import type {
  EntryChange,
  NormalizedEvent,
  RelayMessage,
  RelaySnapshot,
} from "@toggl-waybar-live/shared";

import type { WorkerEnv } from "./env.js";

const storageKey = "snapshot";

interface EventCursor {
  eventId: string;
  eventCreatedAt: string;
}

export interface RelayState {
  cursor: EventCursor | null;
  snapshot: RelaySnapshot | null;
}

export interface RelayTransition {
  messages: RelayMessage[];
  state: RelayState;
}

function compareCursors(left: EventCursor, right: EventCursor): number {
  const timeDifference = Date.parse(left.eventCreatedAt) - Date.parse(right.eventCreatedAt);
  if (timeDifference !== 0) {
    return Math.sign(timeDifference);
  }

  const leftId = BigInt(left.eventId);
  const rightId = BigInt(right.eventId);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function eventChange(event: NormalizedEvent): EntryChange {
  switch (event.action) {
    case "created":
      return { action: "created", entry: event.entry };
    case "updated":
      return { action: "updated", entry: event.entry };
    case "deleted":
      return { action: "deleted", entry: event.entry };
  }
}

function snapshotForEvent(current: RelaySnapshot | null, event: NormalizedEvent): RelaySnapshot {
  if (event.action !== "deleted" && event.entry.stop === null) {
    return {
      status: "running",
      entryId: event.entry.id,
      workspaceId: event.entry.workspaceId,
      projectId: event.entry.projectId,
      description: event.entry.description,
      start: event.entry.start,
      eventId: event.eventId,
      eventCreatedAt: event.eventCreatedAt,
    };
  }

  if (current?.status === "running" && current.entryId !== event.entry.id) {
    return current;
  }

  return {
    status: "idle",
    updatedAt: event.eventCreatedAt,
    eventId: event.eventId,
    eventCreatedAt: event.eventCreatedAt,
  };
}

export function reduceRelayState(
  state: RelayState,
  event: NormalizedEvent,
): RelayTransition | null {
  const cursor = {
    eventId: event.eventId,
    eventCreatedAt: event.eventCreatedAt,
  };
  if (state.cursor !== null && compareCursors(cursor, state.cursor) <= 0) {
    return null;
  }

  const snapshot = snapshotForEvent(state.snapshot, event);
  const messages: RelayMessage[] = [];
  if (snapshot !== state.snapshot) {
    messages.push({ version: 1, type: "snapshot", snapshot });
  }
  messages.push({ version: 1, type: "entry.changed", change: eventChange(event) });

  return {
    state: { cursor, snapshot },
    messages,
  };
}

export class RelayObject extends DurableObject<WorkerEnv> {
  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async applyEvent(event: NormalizedEvent): Promise<void> {
    const state = (await this.ctx.storage.get<RelayState>(storageKey)) ?? {
      cursor: null,
      snapshot: null,
    };
    const transition = reduceRelayState(state, event);
    if (transition === null) {
      return;
    }

    await this.ctx.storage.put(storageKey, transition.state);
    for (const message of transition.messages) {
      this.broadcast(message);
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return Response.json({ error: "websocket_upgrade_required" }, { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);

    const state = await this.ctx.storage.get<RelayState>(storageKey);
    if (state?.snapshot) {
      server.send(
        JSON.stringify({
          version: 1,
          type: "snapshot",
          snapshot: state.snapshot,
        } satisfies RelayMessage),
      );
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  private broadcast(message: RelayMessage): void {
    const serialized = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(serialized);
      } catch {
        try {
          socket.close(1011, "delivery_failed");
        } catch {
          // A failed close must not turn a persisted event into a retryable failure.
        }
      }
    }
  }
}
