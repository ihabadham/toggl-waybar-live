import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { renderOnce } from "../src/renderer.js";
import { publishRuntimeState, readRuntimeState } from "../src/runtime-file.js";
import type { RendererState } from "../src/state.js";

const temporaryDirectories: string[] = [];

async function temporaryStatePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "toggl-waybar-live-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "runtime", "state.json");
}

function rendererState(overrides: Partial<RendererState> = {}): RendererState {
  return {
    status: "running",
    connection: "connected",
    label: "Review",
    description: "Review",
    projectName: "Internal",
    entryStart: "2026-08-27T10:00:00Z",
    todayTrackedSeconds: 3_600,
    runningContributesToToday: true,
    generatedAt: "2026-08-27T11:00:00Z",
    lastSynchronizedAt: "2026-08-27T11:00:00Z",
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("runtime state file", () => {
  it("atomically replaces private state in a private directory", async () => {
    const path = await temporaryStatePath();
    await publishRuntimeState(path, rendererState({ label: "First" }));
    await publishRuntimeState(path, rendererState({ label: "Second" }));

    expect(await readRuntimeState(path)).toMatchObject({ label: "Second" });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ label: "Second" });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(path, ".."))).mode & 0o777).toBe(0o700);
  });

  it("returns null for missing, invalid, oversized, and symlinked state", async () => {
    const path = await temporaryStatePath();
    expect(await readRuntimeState(path)).toBeNull();

    await publishRuntimeState(path, rendererState());
    await writeFile(path, "not-json", { encoding: "utf8", mode: 0o600 });
    expect(await readRuntimeState(path)).toBeNull();

    await writeFile(path, "x".repeat(70_000), "utf8");
    expect(await readRuntimeState(path)).toBeNull();

    await rm(path);
    const target = join(path, "..", "target.json");
    await writeFile(target, JSON.stringify(rendererState()), "utf8");
    await symlink(target, path);
    expect(await readRuntimeState(path)).toBeNull();
    await expect(publishRuntimeState(path, rendererState())).rejects.toThrow("symlink");
  });

  it("serves two concurrent readers and renders invalid state as offline", async () => {
    const path = await temporaryStatePath();
    await publishRuntimeState(path, rendererState());

    const [first, second] = await Promise.all([readRuntimeState(path), readRuntimeState(path)]);
    expect(first).toEqual(second);

    await writeFile(path, "{}", "utf8");
    const rendered = JSON.parse(await renderOnce(path, 12));
    expect(rendered).toMatchObject({ class: ["offline"] });
    expect(rendered.text).toContain("Toggl offline");
    expect(rendered.tooltip).toContain("Relay offline");
  });
});
