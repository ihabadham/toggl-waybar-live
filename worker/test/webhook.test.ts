import type { NormalizedEvent } from "@toggl-waybar-live/shared";
import { describe, expect, it } from "vitest";

import { handleWebhook } from "../src/webhook.js";

const callbackUrl = "https://relay.example/webhooks/toggl";
const secret = "test-webhook-secret";
const targetUserId = "303";
const deliveredAt = "2026-08-27T19:00:00Z";
const now = () => Date.parse(deliveredAt);

const baseEntry = {
  id: 101,
  workspace_id: 202,
  user_id: 303,
  project_id: 404,
  project_name: "Internal",
  description: "Review",
  start: "2026-08-27T18:30:00Z",
  stop: null,
  duration: -1,
};

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: 19,
    created_at: "2026-08-27T19:00:00Z",
    timestamp: deliveredAt,
    url_callback: callbackUrl,
    metadata: {
      request_type: "POST",
      event_user_id: 303,
    },
    payload: baseEntry,
    ...overrides,
  };
}

async function hmacHeader(rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const hex = Array.from(new Uint8Array(signature), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `sha256=${hex}`;
}

async function signedRequest(
  value: Record<string, unknown> | string,
  options: { contentType?: string; method?: string; url?: string } = {},
): Promise<Request> {
  const rawBody = typeof value === "string" ? value : JSON.stringify(value);
  return new Request(options.url ?? callbackUrl, {
    method: options.method ?? "POST",
    headers: {
      "content-type": options.contentType ?? "application/json",
      "x-webhook-signature-256": await hmacHeader(rawBody),
    },
    body: rawBody,
  });
}

function createCollector(): {
  applied: NormalizedEvent[];
  applyEvent: (event: NormalizedEvent) => Promise<void>;
} {
  const applied: NormalizedEvent[] = [];
  return {
    applied,
    applyEvent: async (event) => {
      applied.push(event);
    },
  };
}

const env = {
  TOGGL_USER_ID: targetUserId,
  TOGGL_WEBHOOK_SECRET: secret,
};

describe("Toggl webhook ingress", () => {
  it("normalizes a valid started entry", async () => {
    const collector = createCollector();

    const response = await handleWebhook(
      await signedRequest(envelope()),
      env,
      collector.applyEvent,
      now,
    );

    expect(response.status).toBe(204);
    expect(collector.applied).toEqual([
      {
        eventId: "19",
        eventCreatedAt: "2026-08-27T19:00:00Z",
        deliveredAt,
        callbackUrl,
        action: "created",
        entry: {
          id: "101",
          workspaceId: "202",
          userId: "303",
          projectId: "404",
          projectName: "Internal",
          description: "Review",
          start: "2026-08-27T18:30:00Z",
          stop: null,
          durationSeconds: null,
        },
      },
    ]);
  });

  it("normalizes a stopped entry", async () => {
    const collector = createCollector();
    const stopped = envelope({
      metadata: { request_type: "PATCH", event_user_id: 303 },
      payload: {
        ...baseEntry,
        stop: "2026-08-27T18:35:00Z",
        duration: 300,
      },
    });

    const response = await handleWebhook(
      await signedRequest(stopped),
      env,
      collector.applyEvent,
      now,
    );

    expect(response.status).toBe(204);
    expect(collector.applied[0]).toMatchObject({
      action: "updated",
      entry: { stop: "2026-08-27T18:35:00Z", durationSeconds: 300 },
    });
  });

  it("normalizes a deletion with identifiers only", async () => {
    const collector = createCollector();
    const deleted = envelope({
      metadata: { request_type: "DELETE", event_user_id: 303 },
      payload: { id: 101, wid: 202, uid: 303 },
    });

    const response = await handleWebhook(
      await signedRequest(deleted),
      env,
      collector.applyEvent,
      now,
    );

    expect(response.status).toBe(204);
    expect(collector.applied[0]).toMatchObject({
      action: "deleted",
      entry: { id: "101", workspaceId: "202", userId: "303" },
    });
  });

  it("echoes a signed subscription validation code without applying an event", async () => {
    const collector = createCollector();
    const ping = envelope({ payload: "ping", validation_code: "validate-me" });

    const response = await handleWebhook(await signedRequest(ping), env, collector.applyEvent, now);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ validation_code: "validate-me" });
    expect(collector.applied).toEqual([]);
  });

  it("acknowledges another user's event without applying it", async () => {
    const collector = createCollector();
    const otherUser = envelope({
      metadata: { request_type: "POST", event_user_id: 999 },
    });

    const response = await handleWebhook(
      await signedRequest(otherUser),
      env,
      collector.applyEvent,
      now,
    );

    expect(response.status).toBe(204);
    expect(collector.applied).toEqual([]);
  });

  it("rejects an invalid signature before applying an event", async () => {
    const collector = createCollector();
    const request = await signedRequest(envelope());
    request.headers.set("x-webhook-signature-256", `sha256=${"0".repeat(64)}`);

    const response = await handleWebhook(request, env, collector.applyEvent, now);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "invalid_signature" });
    expect(collector.applied).toEqual([]);
  });

  it("rejects a stale delivery", async () => {
    const collector = createCollector();
    const stale = envelope({ timestamp: "2026-08-27T18:55:00Z" });

    const response = await handleWebhook(
      await signedRequest(stale),
      env,
      collector.applyEvent,
      now,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "stale_delivery" });
    expect(collector.applied).toEqual([]);
  });

  it("rejects a signed callback mismatch", async () => {
    const collector = createCollector();
    const mismatched = envelope({ url_callback: "https://attacker.example/webhook" });

    const response = await handleWebhook(
      await signedRequest(mismatched),
      env,
      collector.applyEvent,
      now,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "callback_mismatch" });
    expect(collector.applied).toEqual([]);
  });

  it("rejects malformed signed JSON", async () => {
    const collector = createCollector();

    const response = await handleWebhook(
      await signedRequest("{not-json"),
      env,
      collector.applyEvent,
      now,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_json" });
    expect(collector.applied).toEqual([]);
  });

  it("rejects an invalid payload", async () => {
    const collector = createCollector();
    const invalid = envelope({ payload: { id: 101 } });

    const response = await handleWebhook(
      await signedRequest(invalid),
      env,
      collector.applyEvent,
      now,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_payload" });
    expect(collector.applied).toEqual([]);
  });

  it("rejects the wrong content type", async () => {
    const collector = createCollector();

    const response = await handleWebhook(
      await signedRequest(envelope(), { contentType: "text/plain" }),
      env,
      collector.applyEvent,
      now,
    );

    expect(response.status).toBe(415);
    expect(collector.applied).toEqual([]);
  });

  it("rejects an oversized body before applying an event", async () => {
    const collector = createCollector();
    const oversized = envelope({
      payload: { ...baseEntry, description: "x".repeat(300_000) },
    });

    const response = await handleWebhook(
      await signedRequest(oversized),
      env,
      collector.applyEvent,
      now,
    );

    expect(response.status).toBe(413);
    expect(collector.applied).toEqual([]);
  });

  it("returns a retryable response when relay application fails", async () => {
    const response = await handleWebhook(
      await signedRequest(envelope()),
      env,
      async () => {
        throw new Error("storage unavailable");
      },
      now,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "relay_unavailable" });
  });
});
