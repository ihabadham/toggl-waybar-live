import { z } from "zod";

const decimalId = /^\d+$/;

export const externalIdSchema = z
  .union([z.string().regex(decimalId), z.number().int().nonnegative().safe()])
  .transform((value) => String(value));

export const rfc3339Schema = z.string().datetime({ offset: true });

export const entryActionSchema = z.enum(["created", "updated", "deleted"]);

export const normalizedEntrySchema = z.strictObject({
  id: externalIdSchema,
  workspaceId: externalIdSchema,
  userId: externalIdSchema,
  projectId: externalIdSchema.nullable(),
  projectName: z.string().nullable(),
  description: z.string(),
  start: rfc3339Schema,
  stop: rfc3339Schema.nullable(),
  durationSeconds: z.number().finite().nonnegative().nullable(),
});

export const deletedEntrySchema = z.strictObject({
  id: externalIdSchema,
  workspaceId: externalIdSchema,
  userId: externalIdSchema,
});

export const entryChangeSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("created"),
    entry: normalizedEntrySchema,
  }),
  z.strictObject({
    action: z.literal("updated"),
    entry: normalizedEntrySchema,
  }),
  z.strictObject({
    action: z.literal("deleted"),
    entry: deletedEntrySchema,
  }),
]);

const eventEnvelopeShape = {
  eventId: externalIdSchema,
  eventCreatedAt: rfc3339Schema,
  deliveredAt: rfc3339Schema,
  callbackUrl: z.url(),
};

export const normalizedEventSchema = z.discriminatedUnion("action", [
  z.strictObject({
    ...eventEnvelopeShape,
    action: z.literal("created"),
    entry: normalizedEntrySchema,
  }),
  z.strictObject({
    ...eventEnvelopeShape,
    action: z.literal("updated"),
    entry: normalizedEntrySchema,
  }),
  z.strictObject({
    ...eventEnvelopeShape,
    action: z.literal("deleted"),
    entry: deletedEntrySchema,
  }),
]);

export type EntryAction = z.infer<typeof entryActionSchema>;
export type NormalizedEntry = z.infer<typeof normalizedEntrySchema>;
export type DeletedEntry = z.infer<typeof deletedEntrySchema>;
export type EntryChange = z.infer<typeof entryChangeSchema>;
export type NormalizedEvent = z.infer<typeof normalizedEventSchema>;
