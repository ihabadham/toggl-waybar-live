import { describe, expect, it } from "vitest";

import { normalizedEventSchema, parseRelayMessage, relayMessageSchema } from "../src/index.js";

const runningSnapshot = {
  version: 1,
  type: "snapshot",
  snapshot: {
    status: "running",
    entryId: 9007199254740991,
    workspaceId: "42",
    projectId: null,
    description: "Review",
    start: "2026-08-27T18:30:00Z",
    eventId: 17,
    eventCreatedAt: "2026-08-27T18:30:01.123Z",
  },
} as const;

describe("relay protocol", () => {
  it("parses a running snapshot and normalizes numeric IDs", () => {
    const message = parseRelayMessage(runningSnapshot);

    expect(message).toEqual({
      ...runningSnapshot,
      snapshot: {
        ...runningSnapshot.snapshot,
        entryId: "9007199254740991",
        eventId: "17",
      },
    });
  });

  it("parses an idle snapshot", () => {
    const message = parseRelayMessage({
      version: 1,
      type: "snapshot",
      snapshot: {
        status: "idle",
        updatedAt: "2026-08-27T20:00:00+02:00",
        eventId: "18",
        eventCreatedAt: "2026-08-27T18:00:00Z",
      },
    });

    expect(message.type).toBe("snapshot");
    if (message.type !== "snapshot") {
      throw new Error("Expected a snapshot message");
    }
    expect(message.snapshot.status).toBe("idle");
  });

  it("normalizes IDs throughout a Toggl event", () => {
    const event = normalizedEventSchema.parse({
      eventId: 19,
      eventCreatedAt: "2026-08-27T18:35:00Z",
      deliveredAt: "2026-08-27T18:35:01Z",
      callbackUrl: "https://relay.example/webhooks/toggl",
      action: "updated",
      entry: {
        id: 101,
        workspaceId: 202,
        userId: 303,
        projectId: 404,
        projectName: "Internal",
        description: "Review",
        start: "2026-08-27T18:30:00Z",
        stop: "2026-08-27T18:35:00Z",
        durationSeconds: 300,
      },
    });

    expect(event).toMatchObject({
      eventId: "19",
      entry: {
        id: "101",
        workspaceId: "202",
        userId: "303",
        projectId: "404",
      },
    });
  });

  it("accepts a deletion with identifiers only", () => {
    const event = normalizedEventSchema.parse({
      eventId: 20,
      eventCreatedAt: "2026-08-27T18:36:00Z",
      deliveredAt: "2026-08-27T18:36:01Z",
      callbackUrl: "https://relay.example/webhooks/toggl",
      action: "deleted",
      entry: {
        id: 101,
        workspaceId: 202,
        userId: 303,
      },
    });

    expect(event).toMatchObject({
      action: "deleted",
      entry: {
        id: "101",
        workspaceId: "202",
        userId: "303",
      },
    });
  });

  it("rejects a datetime without an offset", () => {
    const invalid = {
      ...runningSnapshot,
      snapshot: {
        ...runningSnapshot.snapshot,
        start: "2026-08-27T18:30:00",
      },
    };

    expect(() => parseRelayMessage(invalid)).toThrow();
  });

  it("rejects an unknown protocol version", () => {
    expect(
      relayMessageSchema.safeParse({
        ...runningSnapshot,
        version: 2,
      }).success,
    ).toBe(false);
  });

  it("rejects unknown envelope keys", () => {
    expect(
      relayMessageSchema.safeParse({
        ...runningSnapshot,
        token: "must-not-be-accepted",
      }).success,
    ).toBe(false);
  });
});
