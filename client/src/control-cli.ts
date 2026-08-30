#!/usr/bin/env node

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  ControlClientError,
  sendControlCommand,
  type WatchController,
  watchControlSnapshots,
} from "./control-client.js";
import {
  type CommandResult,
  type ControlRequest,
  controlRequestSchema,
} from "./control-protocol.js";
import { drawerView } from "./drawer-view.js";

type CommandRequest = Exclude<ControlRequest, { type: "watch" }>;

const drawerExecutionTimeoutMilliseconds = 30_000;
const maximumDrawerErrorCharacters = 4_096;

export interface ControlCliOutput {
  once(event: "drain", listener: () => void): unknown;
  write(value: string): boolean;
}

export interface ControlCliDependencies {
  invokeDrawer?: () => Promise<boolean>;
  output?: ControlCliOutput;
  send?: (request: CommandRequest) => Promise<CommandResult>;
  watch?: (onSnapshot: Parameters<typeof watchControlSnapshots>[0]) => WatchController;
  writeError?: (value: string) => void;
  writeOutput?: (value: string) => void;
}

function outputFor(dependencies: ControlCliDependencies): ControlCliOutput {
  if (dependencies.output) {
    return dependencies.output;
  }
  if (dependencies.writeOutput) {
    return {
      once: (_event, listener) => queueMicrotask(listener),
      write: (value) => {
        dependencies.writeOutput?.(value);
        return true;
      },
    };
  }
  return process.stdout;
}

function coalescingWriter(output: ControlCliOutput): {
  close(): void;
  write(value: string): void;
} {
  let blocked = false;
  let closed = false;
  let pending: string | null = null;
  const flush = (): void => {
    if (blocked || closed || pending === null) {
      return;
    }
    const value = pending;
    pending = null;
    if (!output.write(value)) {
      blocked = true;
      output.once("drain", () => {
        blocked = false;
        flush();
      });
    }
  };
  return {
    close: () => {
      closed = true;
      pending = null;
    },
    write: (value) => {
      pending = value;
      flush();
    },
  };
}

function usage(): string {
  return "Usage: toggl-waybar <toggle|stop|resume [preset-id]|watch>";
}

function parseArguments(arguments_: readonly string[]): ControlRequest | null {
  let value: unknown;
  if (arguments_.length === 1 && arguments_[0] === "toggle") {
    value = { version: 1, type: "toggle" };
  } else if (arguments_.length === 1 && arguments_[0] === "stop") {
    value = { version: 1, type: "stop" };
  } else if ((arguments_.length === 1 || arguments_.length === 2) && arguments_[0] === "resume") {
    value = { version: 1, type: "resume", presetId: arguments_[1] ?? null };
  } else if (arguments_.length === 1 && arguments_[0] === "watch") {
    value = { version: 1, type: "watch" };
  } else {
    return null;
  }
  const parsed = controlRequestSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function defaultInvokeDrawer(): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.TOGGL_WAYBAR_DRAWER_EXECUTABLE || "toggl-waybar-drawer",
      ["open"],
      {
        shell: false,
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let errorOutput = "";
    let settled = false;
    const finish = (result: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      result();
    };
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (errorOutput.length < maximumDrawerErrorCharacters) {
        errorOutput += chunk.slice(0, maximumDrawerErrorCharacters - errorOutput.length);
      }
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        finish(() => resolve(false));
      } else {
        finish(() => reject(new ControlClientError(error.message)));
      }
    });
    child.once("close", (exitCode) => {
      finish(() => {
        if (exitCode === 0) {
          resolve(true);
          return;
        }
        const detail = errorOutput.trim();
        reject(
          new ControlClientError(
            detail.length > 0 ? detail : `Toggl drawer exited with status ${exitCode ?? "unknown"}`,
          ),
        );
      });
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new ControlClientError("Toggl drawer command timed out")));
    }, drawerExecutionTimeoutMilliseconds);
    timeout.unref();
  });
}

function resultError(result: CommandResult): string {
  return result.error === null ? "Toggl command failed" : `Toggl command failed: ${result.error}`;
}

export async function runControlCli(
  arguments_: readonly string[],
  dependencies: ControlCliDependencies = {},
): Promise<number> {
  const writeError = dependencies.writeError ?? ((value) => process.stderr.write(value));
  const request = parseArguments(arguments_);
  if (request === null) {
    writeError(`${usage()}\n`);
    return 2;
  }

  if (request.type === "watch") {
    const writer = coalescingWriter(outputFor(dependencies));
    let latestConnected = false;
    let latestSnapshot: Parameters<typeof drawerView>[0] | null = null;
    const emit = (snapshot: Parameters<typeof drawerView>[0]): void => {
      latestSnapshot = snapshot;
      latestConnected = snapshot.error !== "daemon_unavailable";
      writer.write(`${JSON.stringify(drawerView(snapshot))}\n`);
    };
    const controller = (dependencies.watch ?? watchControlSnapshots)(emit);
    const ticker = setInterval(() => {
      if (latestConnected && latestSnapshot !== null) {
        writer.write(`${JSON.stringify(drawerView(latestSnapshot))}\n`);
      }
    }, 1_000);
    await controller.done.finally(() => {
      clearInterval(ticker);
      writer.close();
    });
    return 0;
  }

  try {
    const result = await (dependencies.send ?? sendControlCommand)(request);
    if (result.outcome === "drawer_required") {
      if (
        request.type === "toggle" &&
        (await (dependencies.invokeDrawer ?? defaultInvokeDrawer)())
      ) {
        return 0;
      }
      writeError(
        request.type === "toggle"
          ? "No resumable activity exists and toggl-waybar-drawer is not installed.\n"
          : "No resumable activity exists.\n",
      );
      return 1;
    }
    if (result.outcome === "failed") {
      writeError(`${resultError(result)}\n`);
      return 1;
    }
    return 0;
  } catch (error) {
    writeError(`${error instanceof ControlClientError ? error.message : "Toggl command failed"}\n`);
    return 1;
  }
}

async function main(): Promise<void> {
  process.exitCode = await runControlCli(process.argv.slice(2));
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
