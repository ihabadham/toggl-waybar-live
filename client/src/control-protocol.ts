import { rfc3339Schema } from "@toggl-waybar-live/shared";
import { z } from "zod";

import { maximumPresets } from "./presets.js";
import { projectColorSchema } from "./project-color.js";

const decimalIdSchema = z.string().regex(/^\d+$/);
const monthKeySchema = z.string().regex(/^\d{4}-\d{2}$/);
const timezoneSchema = z.string().refine((value) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}, "Invalid IANA timezone");

export const maximumControlFrameBytes = 64 * 1_024;

export function controlFrameBytes(value: unknown): number {
  return Buffer.byteLength(`${JSON.stringify(value)}\n`, "utf8");
}

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
  projectColor: projectColorSchema.nullable(),
  projectName: z.string().nullable(),
  taskName: z.string().nullable(),
  lastUsedAt: rfc3339Schema,
});

export const controlCurrentEntrySchema = z.strictObject({
  id: decimalIdSchema,
  workspaceId: decimalIdSchema,
  description: z.string(),
  projectId: decimalIdSchema.nullable(),
  projectColor: projectColorSchema.nullable(),
  projectName: z.string().nullable(),
  start: rfc3339Schema,
  taskName: z.string().nullable(),
});

export const controlTodayEntrySchema = z.strictObject({
  id: decimalIdSchema,
  description: z.string(),
  projectId: decimalIdSchema.nullable(),
  projectName: z.string().nullable(),
  projectColor: projectColorSchema.nullable(),
  taskName: z.string().nullable(),
  start: rfc3339Schema,
  stop: rfc3339Schema.nullable(),
  durationSeconds: z.number().finite().nonnegative().nullable(),
});

export const controlMonthProjectionSchema = z.strictObject({
  availability: z.enum(["ready", "stale", "unavailable"]),
  partial: z.boolean(),
  key: monthKeySchema.nullable(),
  completedSeconds: z.number().finite().nonnegative(),
  currentContributes: z.boolean(),
  synchronizedAt: rfc3339Schema.nullable(),
});

export const controlWeekProjectionSchema = controlMonthProjectionSchema.omit({ key: true }).extend({
  key: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
});

export const controlSnapshotSchema = z
  .strictObject({
    version: z.literal(1),
    type: z.literal("snapshot"),
    status: z.enum(["running", "idle", "offline"]),
    connection: z.enum(["connected", "stale", "offline"]),
    confidence: z.enum(["confirmed", "uncertain"]),
    pending: z.enum(["stopping", "resuming"]).nullable(),
    current: controlCurrentEntrySchema.nullable(),
    timezone: timezoneSchema.nullable(),
    completedTodaySeconds: z.number().finite().nonnegative(),
    currentContributesToToday: z.boolean(),
    todayEntries: z.array(controlTodayEntrySchema).max(50),
    todayEntryCount: z.number().int().nonnegative(),
    todayEntriesOmitted: z.number().int().nonnegative(),
    month: controlMonthProjectionSchema,
    week: controlWeekProjectionSchema.optional(),
    presets: z.array(resumePresetSchema).max(maximumPresets),
    generatedAt: rfc3339Schema,
    lastSynchronizedAt: rfc3339Schema.nullable(),
    error: controlErrorCodeSchema.nullable(),
  })
  .superRefine((snapshot, context) => {
    if (snapshot.todayEntries.length + snapshot.todayEntriesOmitted !== snapshot.todayEntryCount) {
      context.addIssue({
        code: "custom",
        message: "Today entry accounting is inconsistent",
        path: ["todayEntriesOmitted"],
      });
    }
    if (snapshot.month.key === null && snapshot.month.availability !== "unavailable") {
      context.addIssue({
        code: "custom",
        message: "Available month data requires a month key",
        path: ["month", "key"],
      });
    }
    if (
      snapshot.timezone === null &&
      !(
        snapshot.status === "offline" &&
        snapshot.connection === "offline" &&
        snapshot.current === null &&
        snapshot.todayEntryCount === 0 &&
        snapshot.month.availability === "unavailable" &&
        snapshot.month.key === null
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Only the daemon-unavailable snapshot may omit timezone",
        path: ["timezone"],
      });
    }
  });

export type ControlErrorCode = z.infer<typeof controlErrorCodeSchema>;
export type CommandOutcome = z.infer<typeof commandOutcomeSchema>;
export type ControlRequest = z.infer<typeof controlRequestSchema>;
export type CommandResult = z.infer<typeof commandResultSchema>;
export type ControlCurrentEntry = z.infer<typeof controlCurrentEntrySchema>;
export type ControlTodayEntry = z.infer<typeof controlTodayEntrySchema>;
export type ControlMonthProjection = z.infer<typeof controlMonthProjectionSchema>;
export type ControlWeekProjection = z.infer<typeof controlWeekProjectionSchema>;
export type ControlSnapshot = z.infer<typeof controlSnapshotSchema>;
