import { z } from "zod";

import { entryChangeSchema, externalIdSchema, rfc3339Schema } from "./toggl.js";

export const runningSnapshotSchema = z.strictObject({
  status: z.literal("running"),
  entryId: externalIdSchema,
  workspaceId: externalIdSchema,
  projectId: externalIdSchema.nullable(),
  description: z.string(),
  start: rfc3339Schema,
  eventId: externalIdSchema,
  eventCreatedAt: rfc3339Schema,
});

export const idleSnapshotSchema = z.strictObject({
  status: z.literal("idle"),
  updatedAt: rfc3339Schema,
  eventId: externalIdSchema,
  eventCreatedAt: rfc3339Schema,
});

export const relaySnapshotSchema = z.discriminatedUnion("status", [
  runningSnapshotSchema,
  idleSnapshotSchema,
]);

const snapshotMessageSchema = z.strictObject({
  version: z.literal(1),
  type: z.literal("snapshot"),
  snapshot: relaySnapshotSchema,
});

const entryChangedMessageSchema = z.strictObject({
  version: z.literal(1),
  type: z.literal("entry.changed"),
  change: entryChangeSchema,
});

export const relayMessageSchema = z.discriminatedUnion("type", [
  snapshotMessageSchema,
  entryChangedMessageSchema,
]);

export type RunningSnapshot = z.infer<typeof runningSnapshotSchema>;
export type IdleSnapshot = z.infer<typeof idleSnapshotSchema>;
export type RelaySnapshot = z.infer<typeof relaySnapshotSchema>;
export type RelayMessage = z.infer<typeof relayMessageSchema>;

export function parseRelayMessage(value: unknown): RelayMessage {
  return relayMessageSchema.parse(value);
}
