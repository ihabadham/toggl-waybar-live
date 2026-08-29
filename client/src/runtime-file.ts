import { join } from "node:path";
import { z } from "zod";

import { readPrivateJson, writePrivateJson } from "./private-json-file.js";
import type { RendererState } from "./state.js";

const maximumStateBytes = 64 * 1_024;

const rendererStateSchema = z.strictObject({
  status: z.enum(["running", "idle", "offline"]),
  connection: z.enum(["connected", "stale", "offline"]),
  label: z.string().nullable(),
  description: z.string().nullable(),
  projectName: z.string().nullable(),
  entryStart: z.iso.datetime({ offset: true }).nullable(),
  todayTrackedSeconds: z.number().finite().nonnegative(),
  runningContributesToToday: z.boolean(),
  generatedAt: z.iso.datetime({ offset: true }),
  lastSynchronizedAt: z.iso.datetime({ offset: true }).nullable(),
});

export function defaultRuntimeStatePath(environment: NodeJS.ProcessEnv = process.env): string {
  const runtimeDirectory = environment.XDG_RUNTIME_DIR;
  if (!runtimeDirectory) {
    throw new Error("XDG_RUNTIME_DIR is required");
  }
  return join(runtimeDirectory, "toggl-waybar-live", "state.json");
}

export async function publishRuntimeState(path: string, state: RendererState): Promise<void> {
  await writePrivateJson(path, state, {
    directoryDescription: "Runtime state directory",
    targetDescription: "Runtime state target",
    temporaryPrefix: "state",
  });
}

export async function readRuntimeState(path: string): Promise<RendererState | null> {
  return readPrivateJson(path, { maximumBytes: maximumStateBytes }, (value) =>
    rendererStateSchema.parse(value),
  );
}
