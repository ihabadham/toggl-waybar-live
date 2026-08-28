import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

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

async function pathIsSymlink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function defaultRuntimeStatePath(environment: NodeJS.ProcessEnv = process.env): string {
  const runtimeDirectory = environment.XDG_RUNTIME_DIR;
  if (!runtimeDirectory) {
    throw new Error("XDG_RUNTIME_DIR is required");
  }
  return join(runtimeDirectory, "toggl-waybar-live", "state.json");
}

export async function publishRuntimeState(path: string, state: RendererState): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) {
    throw new Error("Runtime state directory must not be a symlink");
  }
  await chmod(directory, 0o700);
  if (await pathIsSymlink(path)) {
    throw new Error("Runtime state target must not be a symlink");
  }

  const temporaryPath = join(directory, `.state.${process.pid}.${crypto.randomUUID()}.tmp`);
  let temporaryCreated = false;
  try {
    const file = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    temporaryCreated = true;
    try {
      await file.chmod(0o600);
      await file.writeFile(JSON.stringify(state), "utf8");
      await file.sync();
    } finally {
      await file.close();
    }

    if (await pathIsSymlink(path)) {
      throw new Error("Runtime state target must not be a symlink");
    }
    await rename(temporaryPath, path);
    temporaryCreated = false;

    const directoryHandle = await open(directory, constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    if (temporaryCreated) {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

export async function readRuntimeState(path: string): Promise<RendererState | null> {
  try {
    if (await pathIsSymlink(path)) {
      return null;
    }
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > maximumStateBytes) {
      return null;
    }
    return rendererStateSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return null;
  }
}
