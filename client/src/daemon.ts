#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./config.js";
import { startControlServer } from "./control-server.js";
import { ClientCoordinator } from "./coordinator.js";
import { defaultPresetPath, loadPresets, savePresets } from "./preset-file.js";
import { QuotaGate } from "./quota-gate.js";
import { RelayClient } from "./relay-client.js";
import { publishRuntimeState } from "./runtime-file.js";
import { runtimePaths } from "./runtime-path.js";
import { TogglApi } from "./toggl-api.js";
import { TogglRequestScheduler } from "./toggl-request-scheduler.js";

const maintenanceIntervalMilliseconds = 30_000;

function timestamp(): string {
  return new Date().toISOString();
}

function log(event: string, severity: "info" | "warning" | "error"): void {
  process.stdout.write(`${JSON.stringify({ event, severity, timestamp: timestamp() })}\n`);
}

export interface DaemonController {
  done: Promise<void>;
  stop(): Promise<void>;
}

export async function startDaemon(): Promise<DaemonController> {
  const config = loadConfig();
  const paths = runtimePaths();
  const presetPath = defaultPresetPath();
  const api = new TogglApi(config.togglApiToken, fetch, config.apiBaseUrl);
  const quota = new QuotaGate();
  const requestScheduler = new TogglRequestScheduler();
  let publishQueue = Promise.resolve();
  let maintenance: Promise<void> = Promise.resolve();
  let stopped = false;

  const publish = (
    _snapshot: unknown,
    projection: Parameters<typeof publishRuntimeState>[1],
  ): void => {
    publishQueue = publishQueue
      .then(() => publishRuntimeState(paths.stateFile, projection))
      .catch(() => log("runtime_state_publish_failed", "error"));
  };

  const coordinator = new ClientCoordinator({
    api,
    initialPresets: await loadPresets(presetPath),
    log: (event) => log(event, "warning"),
    persistPresets: (presets) => savePresets(presetPath, presets),
    publish,
    quotaGate: quota,
    requestScheduler,
    timezone: config.timezone,
  });

  const reconcile = async (): Promise<void> => {
    const now = Date.now();
    const action = quota.nextAction(now, coordinator.snapshot().connection === "connected");
    if (action === "none") {
      return;
    }
    quota.recordAttempt(action, now);
    if ((await coordinator.reconcile(action)) === "failed") {
      log("reconciliation_failed", "warning");
    }
  };

  const controlServer = await startControlServer({
    path: paths.controlSocket,
    provider: coordinator,
  });
  publish(coordinator.snapshot(), coordinator.rendererState());
  try {
    await reconcile();
  } catch (error) {
    await controlServer.close();
    await coordinator.drain();
    await publishQueue;
    throw error;
  }

  const relay = new RelayClient({
    url: config.relayUrl,
    token: config.relayToken,
    onOpen: () => {
      coordinator.setConnection("connected");
      log("relay_connected", "info");
    },
    onMessage: (message) => {
      coordinator.applyRelay(message);
    },
    onStale: () => {
      coordinator.setConnection("stale");
      log("relay_stale", "warning");
    },
    onClose: () => {
      if (!stopped) {
        coordinator.setConnection("stale");
        log("relay_disconnected", "warning");
      }
    },
  });
  relay.start();

  const maintenanceTimer = setInterval(() => {
    maintenance = maintenance
      .then(async () => {
        coordinator.advanceCalendar();
        await reconcile();
      })
      .catch(() => log("maintenance_failed", "error"));
  }, maintenanceIntervalMilliseconds);

  let finish: (() => void) | undefined;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const stop = async (): Promise<void> => {
    if (stopped) {
      return done;
    }
    stopped = true;
    clearInterval(maintenanceTimer);
    relay.stop();
    process.off("SIGTERM", handleSignal);
    process.off("SIGINT", handleSignal);
    await controlServer.close();
    await maintenance;
    await coordinator.drain();
    await publishQueue;
    finish?.();
  };
  const handleSignal = (): void => {
    void stop();
  };
  process.on("SIGTERM", handleSignal);
  process.on("SIGINT", handleSignal);

  return { done, stop };
}

async function main(): Promise<void> {
  try {
    const daemon = await startDaemon();
    await daemon.done;
  } catch {
    log("daemon_start_failed", "error");
    process.exitCode = 1;
  }
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
