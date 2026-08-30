#!/usr/bin/env node

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const defaultConfigDirectory = "__TOGGL_WAYBAR_EWW_CONFIG_DIR__";
const drawerName = "toggl-drawer";
const drawerMode = "toggl-waybar-drawer";
const defaultRevealDurationMilliseconds = 180;

type DrawerAction = "open" | "close" | "toggle";

interface ParsedArguments {
  action: DrawerAction;
  output: string | null;
}

export interface DrawerCommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export interface DrawerControllerDependencies {
  configDirectory?: string;
  revealDurationMilliseconds?: number;
  run?: (command: string, arguments_: readonly string[]) => Promise<DrawerCommandResult>;
  sleep?: (milliseconds: number) => Promise<void>;
  writeError?: (value: string) => void;
}

function usage(): string {
  return "Usage: toggl-waybar-drawer <open|close|toggle> [--output OUTPUT]";
}

function parseArguments(arguments_: readonly string[]): ParsedArguments | null {
  const action = arguments_[0];
  if (action !== "open" && action !== "close" && action !== "toggle") {
    return null;
  }
  if (arguments_.length === 1) {
    return { action, output: null };
  }
  const output = arguments_[2];
  if (
    arguments_.length !== 3 ||
    arguments_[1] !== "--output" ||
    output === undefined ||
    output.trim().length === 0
  ) {
    return null;
  }
  return { action, output };
}

function runCommand(command: string, arguments_: readonly string[]): Promise<DrawerCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...arguments_], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({ exitCode: exitCode ?? 1, stdout, stderr });
    });
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function ewwArguments(configDirectory: string, ...arguments_: string[]): string[] {
  return ["--config", configDirectory, ...arguments_];
}

function failureMessage(command: string, result: DrawerCommandResult): string {
  const detail = result.stderr.trim();
  return detail.length > 0 ? detail : `${command} exited with status ${result.exitCode}`;
}

function focusedOutput(stdout: string): string | null {
  try {
    const workspaces: unknown = JSON.parse(stdout);
    if (!Array.isArray(workspaces)) {
      return null;
    }
    const focused = workspaces.find(
      (workspace): workspace is { focused: true; output: unknown } =>
        typeof workspace === "object" &&
        workspace !== null &&
        "focused" in workspace &&
        workspace.focused === true,
    );
    return typeof focused?.output === "string" && focused.output.trim().length > 0
      ? focused.output
      : null;
  } catch {
    return null;
  }
}

function hasDrawerWindow(stdout: string): boolean {
  return stdout.split("\n").some((line) => line.split(":", 1)[0]?.trim() === drawerName);
}

function hasDrawerMode(stdout: string): boolean {
  try {
    const modes: unknown = JSON.parse(stdout);
    return (
      Array.isArray(modes) &&
      modes.every((mode): mode is string => typeof mode === "string") &&
      modes.includes(drawerMode)
    );
  } catch {
    return false;
  }
}

export async function runDrawerController(
  arguments_: readonly string[],
  dependencies: DrawerControllerDependencies = {},
): Promise<number> {
  const parsed = parseArguments(arguments_);
  const writeError = dependencies.writeError ?? ((value) => process.stderr.write(value));
  if (parsed === null) {
    writeError(`${usage()}\n`);
    return 2;
  }

  const configDirectory = dependencies.configDirectory ?? defaultConfigDirectory;
  const revealDurationMilliseconds =
    dependencies.revealDurationMilliseconds ?? defaultRevealDurationMilliseconds;
  const run = dependencies.run ?? runCommand;
  const sleep = dependencies.sleep ?? delay;
  const eww = (...ewwArguments_: string[]) =>
    run("eww", ewwArguments(configDirectory, ...ewwArguments_));

  const cleanupFailedOpen = async (originalFailure: string): Promise<number> => {
    const failures = [originalFailure];
    try {
      const closed = await eww("close", drawerName);
      if (closed.exitCode !== 0) {
        failures.push(
          `Unable to clean up the Toggl drawer window: ${failureMessage("eww", closed)}`,
        );
      }
    } catch (error) {
      failures.push(
        `Unable to clean up the Toggl drawer window: ${error instanceof Error ? error.message : "eww failed"}`,
      );
    }
    try {
      const restored = await run("swaymsg", ["mode", "default"]);
      if (restored.exitCode !== 0) {
        failures.push(
          `Unable to restore the default Sway mode: ${failureMessage("swaymsg", restored)}`,
        );
      }
    } catch (error) {
      failures.push(
        `Unable to restore the default Sway mode: ${error instanceof Error ? error.message : "swaymsg failed"}`,
      );
    }
    writeError(`${failures.join("\n")}\n`);
    return 1;
  };

  const open = async (): Promise<number> => {
    let output = parsed.output;
    if (output === null) {
      const result = await run("swaymsg", ["-t", "get_workspaces", "--raw"]);
      if (result.exitCode !== 0) {
        writeError(
          `Unable to determine the focused Sway workspace output: ${failureMessage("swaymsg", result)}\n`,
        );
        return 1;
      }
      output = focusedOutput(result.stdout);
      if (output === null) {
        writeError("Unable to determine the focused Sway workspace output from Sway IPC.\n");
        return 1;
      }
    }

    const opened = await eww("open", drawerName, "--id", drawerName, "--screen", output);
    if (opened.exitCode !== 0) {
      writeError(`Unable to open the Toggl drawer: ${failureMessage("eww", opened)}\n`);
      return 1;
    }
    try {
      const revealed = await eww("update", "drawer_revealed=true");
      if (revealed.exitCode !== 0) {
        return cleanupFailedOpen(
          `Unable to reveal the Toggl drawer: ${failureMessage("eww", revealed)}`,
        );
      }
    } catch (error) {
      return cleanupFailedOpen(
        `Unable to reveal the Toggl drawer: ${error instanceof Error ? error.message : "eww failed"}`,
      );
    }

    try {
      const modes = await run("swaymsg", ["-t", "get_binding_modes", "--raw"]);
      if (modes.exitCode === 0 && hasDrawerMode(modes.stdout)) {
        await run("swaymsg", ["mode", drawerMode]);
      }
    } catch {
      // Opening the drawer does not depend on the optional Escape binding mode.
    }
    return 0;
  };

  const close = async (): Promise<number> => {
    const failures: string[] = [];
    try {
      const hidden = await eww("update", "drawer_revealed=false");
      if (hidden.exitCode !== 0) {
        failures.push(`Unable to hide the Toggl drawer: ${failureMessage("eww", hidden)}`);
      }
    } catch (error) {
      failures.push(
        `Unable to hide the Toggl drawer: ${error instanceof Error ? error.message : "eww failed"}`,
      );
    }

    await sleep(revealDurationMilliseconds);
    try {
      const closed = await eww("close", drawerName);
      if (closed.exitCode !== 0) {
        failures.push(`Unable to close the Toggl drawer: ${failureMessage("eww", closed)}`);
      }
    } catch (error) {
      failures.push(
        `Unable to close the Toggl drawer: ${error instanceof Error ? error.message : "eww failed"}`,
      );
    }

    try {
      const restored = await run("swaymsg", ["mode", "default"]);
      if (restored.exitCode !== 0) {
        failures.push(
          `Unable to restore the default Sway mode: ${failureMessage("swaymsg", restored)}`,
        );
      }
    } catch (error) {
      failures.push(
        `Unable to restore the default Sway mode: ${error instanceof Error ? error.message : "swaymsg failed"}`,
      );
    }

    if (failures.length > 0) {
      writeError(`${failures.join("\n")}\n`);
      return 1;
    }
    return 0;
  };

  try {
    if (parsed.action === "open") {
      return await open();
    }
    if (parsed.action === "close") {
      return await close();
    }

    const active = await eww("active-windows");
    if (active.exitCode !== 0) {
      writeError(`Unable to inspect active Eww windows: ${failureMessage("eww", active)}\n`);
      return 1;
    }
    return hasDrawerWindow(active.stdout) ? await close() : await open();
  } catch (error) {
    writeError(`${error instanceof Error ? error.message : "Toggl drawer command failed"}\n`);
    return 1;
  }
}

async function main(): Promise<void> {
  process.exitCode = await runDrawerController(process.argv.slice(2));
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
