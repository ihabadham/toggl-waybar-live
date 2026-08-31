#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadRendererOptions } from "./config.js";
import { renderWaybar } from "./render.js";
import { defaultRuntimeStatePath, readRuntimeState } from "./runtime-file.js";
import type { RendererState } from "./state.js";

const tickMilliseconds = 1_000;

const offlineState: RendererState = {
  status: "offline",
  connection: "offline",
  label: null,
  description: null,
  projectName: null,
  entryStart: null,
  todayTrackedSeconds: 0,
  runningContributesToToday: false,
  generatedAt: new Date(0).toISOString(),
  lastSynchronizedAt: null,
  pending: null,
};

export async function renderOnce(
  runtimePath: string,
  labelMaxChars: number,
  now = new Date().toISOString(),
): Promise<string> {
  const state = (await readRuntimeState(runtimePath)) ?? offlineState;
  return JSON.stringify(renderWaybar(state, now, { labelMaxChars }));
}

async function main(): Promise<void> {
  let runtimePath: string;
  let labelMaxChars: number;
  try {
    const config = loadRendererOptions();
    runtimePath = defaultRuntimeStatePath();
    labelMaxChars = config.labelMaxChars;
  } catch {
    process.stdout.write(
      `${JSON.stringify(renderWaybar(offlineState, new Date().toISOString(), { labelMaxChars: 12 }))}\n`,
    );
    return;
  }

  let writing = false;
  const tick = async (): Promise<void> => {
    if (writing) {
      return;
    }
    writing = true;
    try {
      process.stdout.write(`${await renderOnce(runtimePath, labelMaxChars)}\n`);
    } finally {
      writing = false;
    }
  };

  await tick();
  const timer = setInterval(() => void tick(), tickMilliseconds);
  const stop = (): void => {
    clearInterval(timer);
    process.exitCode = 0;
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

function isMainModule(): boolean {
  try {
    return Boolean(
      process.argv[1] &&
        realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)),
    );
  } catch {
    return false;
  }
}

if (isMainModule()) {
  await main();
}
