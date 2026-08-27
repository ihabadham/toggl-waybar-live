import {
  type EntryAction,
  externalIdSchema,
  type NormalizedEvent,
  normalizedEventSchema,
  rfc3339Schema,
} from "@toggl-waybar-live/shared";

import type { ApplyEvent, WorkerEnv } from "./env.js";
import { verifyTogglSignature } from "./signature.js";

const maximumBodyBytes = 256 * 1024;
const maximumDeliveryAgeMilliseconds = 120_000;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstDefined(record: UnknownRecord, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) {
      return record[key];
    }
  }

  return undefined;
}

function jsonResponse(status: number, body: UnknownRecord): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function errorResponse(status: number, code: string): Response {
  return jsonResponse(status, { error: code });
}

function actionFromRequestType(value: unknown): EntryAction {
  switch (value) {
    case "POST":
      return "created";
    case "PUT":
    case "PATCH":
      return "updated";
    case "DELETE":
      return "deleted";
    default:
      throw new Error("Unsupported webhook action");
  }
}

function normalizeId(value: unknown): string {
  return externalIdSchema.parse(value);
}

function normalizeOptionalId(value: unknown): string | null {
  return value === null || value === undefined ? null : normalizeId(value);
}

function normalizeDeletedEntry(
  payload: UnknownRecord,
  metadata: UnknownRecord,
): { id: string; workspaceId: string; userId: string } {
  return {
    id: normalizeId(payload.id),
    workspaceId: normalizeId(firstDefined(payload, ["workspace_id", "wid"])),
    userId: normalizeId(firstDefined(payload, ["user_id", "uid"]) ?? metadata.event_user_id),
  };
}

function normalizeStop(start: string, rawStop: unknown, rawDuration: unknown): string | null {
  if (typeof rawStop === "string") {
    return rfc3339Schema.parse(rawStop);
  }

  if (typeof rawDuration === "number" && Number.isFinite(rawDuration) && rawDuration >= 0) {
    return new Date(Date.parse(start) + rawDuration * 1_000).toISOString();
  }

  return null;
}

function normalizeDuration(
  start: string,
  stop: string | null,
  rawDuration: unknown,
): number | null {
  if (stop === null) {
    return null;
  }

  if (typeof rawDuration === "number" && Number.isFinite(rawDuration) && rawDuration >= 0) {
    return rawDuration;
  }

  return Math.max(0, (Date.parse(stop) - Date.parse(start)) / 1_000);
}

function normalizeEvent(envelope: UnknownRecord, metadata: UnknownRecord): NormalizedEvent {
  const action = actionFromRequestType(metadata.request_type);
  if (!isRecord(envelope.payload)) {
    throw new Error("Webhook payload must be an object");
  }

  const payload = envelope.payload;
  const eventEnvelope = {
    eventId: envelope.event_id,
    eventCreatedAt: envelope.created_at,
    deliveredAt: envelope.timestamp,
    callbackUrl: envelope.url_callback,
  };

  if (action === "deleted") {
    return normalizedEventSchema.parse({
      ...eventEnvelope,
      action,
      entry: normalizeDeletedEntry(payload, metadata),
    });
  }

  const start = rfc3339Schema.parse(payload.start);
  const rawDuration = payload.duration;
  const stop = normalizeStop(start, payload.stop, rawDuration);
  const description = payload.description;
  const projectName = payload.project_name;

  return normalizedEventSchema.parse({
    ...eventEnvelope,
    action,
    entry: {
      id: payload.id,
      workspaceId: firstDefined(payload, ["workspace_id", "wid"]),
      userId: firstDefined(payload, ["user_id", "uid"]) ?? metadata.event_user_id,
      projectId: normalizeOptionalId(firstDefined(payload, ["project_id", "pid"])),
      projectName: typeof projectName === "string" ? projectName : null,
      description: typeof description === "string" ? description : "",
      start,
      stop,
      durationSeconds: normalizeDuration(start, stop, rawDuration),
    },
  });
}

function contentTypeIsJson(request: Request): boolean {
  return (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ===
    "application/json"
  );
}

function declaredBodyIsTooLarge(request: Request): boolean {
  const value = request.headers.get("content-length");
  if (value === null) {
    return false;
  }

  const length = Number(value);
  return Number.isFinite(length) && length > maximumBodyBytes;
}

export async function handleWebhook(
  request: Request,
  env: Pick<WorkerEnv, "TOGGL_USER_ID" | "TOGGL_WEBHOOK_SECRET">,
  applyEvent: ApplyEvent,
  now: () => number = Date.now,
): Promise<Response> {
  if (request.method !== "POST") {
    return errorResponse(405, "method_not_allowed");
  }

  if (!contentTypeIsJson(request)) {
    return errorResponse(415, "unsupported_media_type");
  }

  if (declaredBodyIsTooLarge(request)) {
    return errorResponse(413, "body_too_large");
  }

  const rawBody = new Uint8Array(await request.arrayBuffer());
  if (rawBody.byteLength > maximumBodyBytes) {
    return errorResponse(413, "body_too_large");
  }

  const signatureIsValid = await verifyTogglSignature(
    rawBody,
    request.headers.get("x-webhook-signature-256"),
    env.TOGGL_WEBHOOK_SECRET,
  );
  if (!signatureIsValid) {
    return errorResponse(401, "invalid_signature");
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return errorResponse(400, "invalid_json");
  }

  if (!isRecord(envelope) || !isRecord(envelope.metadata)) {
    return errorResponse(400, "invalid_payload");
  }

  if (envelope.url_callback !== request.url) {
    return errorResponse(400, "callback_mismatch");
  }

  const deliveredAt =
    typeof envelope.timestamp === "string" ? Date.parse(envelope.timestamp) : Number.NaN;
  if (
    !Number.isFinite(deliveredAt) ||
    Math.abs(now() - deliveredAt) > maximumDeliveryAgeMilliseconds
  ) {
    return errorResponse(400, "stale_delivery");
  }

  let eventUserId: string;
  try {
    eventUserId = normalizeId(envelope.metadata.event_user_id);
  } catch {
    return errorResponse(400, "invalid_payload");
  }

  if (eventUserId !== env.TOGGL_USER_ID) {
    return new Response(null, { status: 204 });
  }

  if (envelope.payload === "ping") {
    if (typeof envelope.validation_code === "string") {
      return jsonResponse(200, { validation_code: envelope.validation_code });
    }
    return new Response(null, { status: 204 });
  }

  let event: NormalizedEvent;
  try {
    event = normalizeEvent(envelope, envelope.metadata);
  } catch {
    return errorResponse(400, "invalid_payload");
  }

  try {
    await applyEvent(event);
  } catch {
    return errorResponse(503, "relay_unavailable");
  }

  return new Response(null, { status: 204 });
}
