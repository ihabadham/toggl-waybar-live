import { rfc3339Schema } from "@toggl-waybar-live/shared";
import { z } from "zod";

import { maximumPresets } from "./presets.js";

const decimalIdSchema = z.string().regex(/^\d+$/);

export const controlErrorCodeSchema = z.enum([
  "daemon_unavailable",
  "authentication_failed",
  "quota_exhausted",
  "state_unconfirmed",
  "ambiguous_create",
  "preset_not_found",
  "command_busy",
  "request_failed",
]);

export const commandOutcomeSchema = z.enum([
  "stopped",
  "resumed",
  "already_idle",
  "already_running",
  "duplicate_suppressed",
  "drawer_required",
  "failed",
]);

export const controlRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({ version: z.literal(1), type: z.literal("toggle") }),
  z.strictObject({ version: z.literal(1), type: z.literal("stop") }),
  z.strictObject({
    version: z.literal(1),
    type: z.literal("resume"),
    presetId: z.uuid().nullable(),
  }),
  z.strictObject({ version: z.literal(1), type: z.literal("watch") }),
]);

export const commandResultSchema = z.strictObject({
  version: z.literal(1),
  type: z.literal("result"),
  outcome: commandOutcomeSchema,
  error: controlErrorCodeSchema.nullable(),
});

export const resumePresetSchema = z.strictObject({
  id: z.uuid(),
  workspaceId: decimalIdSchema,
  description: z.string(),
  projectId: decimalIdSchema.nullable(),
  taskId: decimalIdSchema.nullable(),
  tagIds: z.array(decimalIdSchema),
  tags: z.array(z.string()),
  billable: z.boolean(),
  projectName: z.string().nullable(),
  taskName: z.string().nullable(),
  lastUsedAt: rfc3339Schema,
});

export const controlCurrentEntrySchema = z.strictObject({
  id: decimalIdSchema,
  workspaceId: decimalIdSchema,
  description: z.string(),
  projectId: decimalIdSchema.nullable(),
  projectName: z.string().nullable(),
  start: rfc3339Schema,
});

export const controlSnapshotSchema = z.strictObject({
  version: z.literal(1),
  type: z.literal("snapshot"),
  status: z.enum(["running", "idle", "offline"]),
  connection: z.enum(["connected", "stale", "offline"]),
  confidence: z.enum(["confirmed", "uncertain"]),
  pending: z.enum(["stopping", "resuming"]).nullable(),
  current: controlCurrentEntrySchema.nullable(),
  completedTodaySeconds: z.number().finite().nonnegative(),
  currentContributesToToday: z.boolean(),
  presets: z.array(resumePresetSchema).max(maximumPresets),
  generatedAt: rfc3339Schema,
  lastSynchronizedAt: rfc3339Schema.nullable(),
  error: controlErrorCodeSchema.nullable(),
});

export type ControlErrorCode = z.infer<typeof controlErrorCodeSchema>;
export type CommandOutcome = z.infer<typeof commandOutcomeSchema>;
export type ControlRequest = z.infer<typeof controlRequestSchema>;
export type CommandResult = z.infer<typeof commandResultSchema>;
export type ControlCurrentEntry = z.infer<typeof controlCurrentEntrySchema>;
export type ControlSnapshot = z.infer<typeof controlSnapshotSchema>;
