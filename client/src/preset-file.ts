import { join } from "node:path";
import { z } from "zod";
import { maximumPresets, type ResumePreset } from "./presets.js";
import { readPrivateJson, writePrivateJson } from "./private-json-file.js";

const maximumPresetFileBytes = 64 * 1_024;

const presetSchema = z.strictObject({
  id: z.uuid(),
  workspaceId: z.string().regex(/^\d+$/),
  description: z.string(),
  projectId: z.string().regex(/^\d+$/).nullable(),
  taskId: z.string().regex(/^\d+$/).nullable(),
  tagIds: z.array(z.string().regex(/^\d+$/)),
  tags: z.array(z.string()),
  billable: z.boolean(),
  projectName: z.string().nullable(),
  taskName: z.string().nullable(),
  lastUsedAt: z.iso.datetime({ offset: true }),
});

const presetFileSchema = z.strictObject({
  version: z.literal(1),
  presets: z.array(presetSchema).max(maximumPresets),
});

export function defaultPresetPath(environment: NodeJS.ProcessEnv = process.env): string {
  const stateHome =
    environment.XDG_STATE_HOME || (environment.HOME && join(environment.HOME, ".local", "state"));
  if (!stateHome) {
    throw new Error("HOME or XDG_STATE_HOME is required");
  }
  return join(stateHome, "toggl-waybar-live", "presets.json");
}

export async function loadPresets(path: string): Promise<ResumePreset[]> {
  const file = await readPrivateJson(path, { maximumBytes: maximumPresetFileBytes }, (value) =>
    presetFileSchema.parse(value),
  );
  return file?.presets ?? [];
}

export async function savePresets(path: string, presets: readonly ResumePreset[]): Promise<void> {
  const file = presetFileSchema.parse({ version: 1, presets });
  if (Buffer.byteLength(JSON.stringify(file), "utf8") > maximumPresetFileBytes) {
    throw new Error("Preset file must not exceed 64 KiB");
  }
  await writePrivateJson(path, file, {
    directoryDescription: "Preset directory",
    targetDescription: "Preset target",
    temporaryPrefix: "presets",
  });
}
