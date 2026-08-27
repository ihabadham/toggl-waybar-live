#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./config.js";
import { dayWindowAt } from "./day-window.js";
import { QuotaGate } from "./quota-gate.js";
import { RelayClient } from "./relay-client.js";
import { defaultRuntimeStatePath, publishRuntimeState } from "./runtime-file.js";
import {
  advanceDay,
  applyRelayMessage,
  type ClientState,
  createState,
  replaceReconciledCurrent,
  replaceReconciledEntries,
  setConnection,
  toRendererState,
} from "./state.js";
import { TogglApi } from "./toggl-api.js";

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
  const runtimePath = defaultRuntimeStatePath();
  const api = new TogglApi(config.togglApiToken);
  const quota = new QuotaGate();
  let state: ClientState = createState(dayWindowAt(new Date(), config.timezone).dayKey);
  let publishQueue = Promise.resolve();
  let maintenance: Promise<void> = Promise.resolve();
  let stopped = false;

  const publish = (): void => {
    const projection = toRendererState(state, timestamp());
    publishQueue = publishQueue
      .then(() => publishRuntimeState(runtimePath, projection))
      .catch(() => log("runtime_state_publish_failed", "error"));
  };

  const reconcile = async (): Promise<void> => {
    const now = Date.now();
    const action = quota.nextAction(now, state.connection === "connected");
    if (action === "none") {
      return;
    }
    quota.recordAttempt(action, now);
    const window = dayWindowAt(new Date(now), config.timezone);

    if (action === "current") {
      const current = await api.fetchCurrent();
      quota.record(current, Date.now());
      if (current.ok) {
        state = replaceReconciledCurrent(state, current.data, window, timestamp());
        if (state.connection === "offline") {
          state = setConnection(state, "stale");
        }
        publish();
      } else if (current.permanent) {
        log("toggl_authentication_failed", "error");
      }
      return;
    }

    const [today, current] = await Promise.all([api.fetchToday(window), api.fetchCurrent()]);
    quota.record(today, Date.now());
    quota.record(current, Date.now());
    if (today.ok && current.ok) {
      state = replaceReconciledEntries(state, today.data, current.data, window, timestamp());
      if (state.connection === "offline") {
        state = setConnection(state, "stale");
      }
      publish();
    } else if ((!today.ok && today.permanent) || (!current.ok && current.permanent)) {
      log("toggl_authentication_failed", "error");
    } else {
      log("reconciliation_failed", "warning");
    }
  };

  publish();
  await reconcile();

  const relay = new RelayClient({
    url: config.relayUrl,
    token: config.relayToken,
    onOpen: () => {
      state = setConnection(state, "connected");
      publish();
      log("relay_connected", "info");
    },
    onMessage: (message) => {
      state = applyRelayMessage(state, message, dayWindowAt(new Date(), config.timezone));
      publish();
    },
    onStale: () => {
      state = setConnection(state, "stale");
      publish();
      log("relay_stale", "warning");
    },
    onClose: () => {
      if (!stopped) {
        state = setConnection(state, "stale");
        publish();
        log("relay_disconnected", "warning");
      }
    },
  });
  relay.start();

  const maintenanceTimer = setInterval(() => {
    maintenance = maintenance
      .then(async () => {
        const window = dayWindowAt(new Date(), config.timezone);
        const previousDay = state.dayKey;
        state = advanceDay(state, window);
        if (state.dayKey !== previousDay) {
          publish();
        }
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
    await maintenance;
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
