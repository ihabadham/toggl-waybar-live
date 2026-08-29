import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { defaultPresetPath, loadPresets, savePresets } from "../src/preset-file.js";
import type { ResumePreset } from "../src/presets.js";

const temporaryDirectories: string[] = [];

async function temporaryPresetPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "toggl-waybar-live-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "state", "presets.json");
}

function preset(overrides: Partial<ResumePreset> = {}): ResumePreset {
  return {
    id: "0182cc10-54d1-7c35-b4f3-e93bb4c0b100",
    workspaceId: "202",
    description: "Review",
    projectId: "404",
    taskId: "505",
    tagIds: ["606"],
    tags: ["client"],
    billable: true,
    projectName: "Internal",
    taskName: "Write tests",
    lastUsedAt: "2026-08-27T10:00:00Z",
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("preset file", () => {
  it("uses the XDG state path and atomically persists restart-safe private presets", async () => {
    expect(defaultPresetPath({ XDG_STATE_HOME: "/xdg", HOME: "/home/test" })).toBe(
      "/xdg/toggl-waybar-live/presets.json",
    );
    expect(defaultPresetPath({ HOME: "/home/test" })).toBe(
      "/home/test/.local/state/toggl-waybar-live/presets.json",
    );

    const path = await temporaryPresetPath();
    await savePresets(path, [preset()]);

    expect(await loadPresets(path)).toEqual([preset()]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, presets: [preset()] });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(path, ".."))).mode & 0o777).toBe(0o700);
  });

  it("loads missing, corrupt, oversized, and invalid files as an empty preset list", async () => {
    const path = await temporaryPresetPath();
    expect(await loadPresets(path)).toEqual([]);

    await savePresets(path, [preset()]);
    await writeFile(path, "not-json", { encoding: "utf8", mode: 0o600 });
    expect(await loadPresets(path)).toEqual([]);

    await writeFile(path, JSON.stringify({ version: 2, presets: [] }), "utf8");
    expect(await loadPresets(path)).toEqual([]);

    await writeFile(path, "x".repeat(70_000), "utf8");
    expect(await loadPresets(path)).toEqual([]);
  });

  it("rejects an oversized save without replacing the persisted presets", async () => {
    const path = await temporaryPresetPath();
    await savePresets(path, [preset()]);

    await expect(savePresets(path, [preset({ description: "x".repeat(70_000) })])).rejects.toThrow(
      "64 KiB",
    );
    expect(await loadPresets(path)).toEqual([preset()]);
  });

  it("refuses preset symlinks for both reading and writing", async () => {
    const path = await temporaryPresetPath();
    const directory = join(path, "..");
    await savePresets(path, [preset()]);
    await rm(path);
    const target = join(directory, "target.json");
    await writeFile(target, JSON.stringify({ version: 1, presets: [preset()] }), "utf8");
    await symlink(target, path);

    expect(await loadPresets(path)).toEqual([]);
    await expect(savePresets(path, [preset()])).rejects.toThrow("symlink");
  });
});
