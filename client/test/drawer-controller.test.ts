import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  type DrawerCommandResult,
  type DrawerControllerDependencies,
  runDrawerController,
} from "../src/drawer-controller.js";

const configDirectory = "/home/test/.local/share/toggl-waybar-live/eww";
const clientDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDirectory = resolve(clientDirectory, "..");

function commandResult(overrides: Partial<DrawerCommandResult> = {}): DrawerCommandResult {
  return { exitCode: 0, stdout: "", stderr: "", ...overrides };
}

function harness(
  results: readonly DrawerCommandResult[],
  overrides: Partial<DrawerControllerDependencies> = {},
) {
  const calls: Array<{ command: string; arguments: readonly string[] }> = [];
  const errors: string[] = [];
  const queue = [...results];
  const run = vi.fn(async (command: string, arguments_: readonly string[]) => {
    calls.push({ command, arguments: arguments_ });
    const result = queue.shift();
    if (result === undefined) {
      throw new Error(`Unexpected command: ${command} ${arguments_.join(" ")}`);
    }
    return result;
  });
  return {
    calls,
    dependencies: {
      configDirectory,
      revealDurationMilliseconds: 180,
      run,
      sleep: vi.fn(async () => undefined),
      writeError: (value: string) => errors.push(value),
      ...overrides,
    } satisfies DrawerControllerDependencies,
    errors,
    run,
  };
}

describe("drawer controller", () => {
  it("opens the fixed window on an explicitly selected output and enters an available mode", async () => {
    const { calls, dependencies, errors } = harness([
      commandResult(),
      commandResult(),
      commandResult({ stdout: '["default","toggl-waybar-drawer"]\n' }),
      commandResult(),
    ]);

    expect(await runDrawerController(["open", "--output", "DP-2"], dependencies)).toBe(0);
    expect(calls).toEqual([
      {
        command: "eww",
        arguments: [
          "--config",
          configDirectory,
          "open",
          "toggl-drawer",
          "--id",
          "toggl-drawer",
          "--screen",
          "DP-2",
        ],
      },
      {
        command: "eww",
        arguments: ["--config", configDirectory, "update", "drawer_revealed=true"],
      },
      {
        command: "swaymsg",
        arguments: ["-t", "get_binding_modes", "--raw"],
      },
      { command: "swaymsg", arguments: ["mode", "toggl-waybar-drawer"] },
    ]);
    expect(errors).toEqual([]);
  });

  it("opens on the focused workspace output without guessing a monitor index", async () => {
    const { calls, dependencies } = harness([
      commandResult({
        stdout: JSON.stringify([
          { name: "1", focused: false, output: "DP-1" },
          { name: "2", focused: true, output: "HDMI-A-1" },
        ]),
      }),
      commandResult(),
      commandResult(),
      commandResult({ exitCode: 1, stderr: "binding modes unavailable" }),
    ]);

    expect(await runDrawerController(["open"], dependencies)).toBe(0);
    expect(calls[0]).toEqual({
      command: "swaymsg",
      arguments: ["-t", "get_workspaces", "--raw"],
    });
    expect(calls[1]?.arguments).toEqual([
      "--config",
      configDirectory,
      "open",
      "toggl-drawer",
      "--id",
      "toggl-drawer",
      "--screen",
      "HDMI-A-1",
    ]);
    expect(calls).toHaveLength(4);
  });

  it.each([
    ["not JSON"],
    [JSON.stringify({ focused: true, output: "DP-1" })],
    [JSON.stringify([{ focused: true, output: "" }])],
    [JSON.stringify([{ focused: false, output: "DP-1" }])],
  ])("rejects malformed focused workspace output %j", async (stdout) => {
    const { dependencies, errors, run } = harness([commandResult({ stdout })]);

    expect(await runDrawerController(["open"], dependencies)).toBe(1);
    expect(run).toHaveBeenCalledOnce();
    expect(errors.join("")).toContain("focused Sway workspace output");
  });

  it("does not let optional mode discovery fail an otherwise successful open", async () => {
    const { calls, dependencies, errors } = harness([
      commandResult(),
      commandResult(),
      commandResult({ stdout: '{"default":true}' }),
    ]);

    expect(await runDrawerController(["open", "--output", "DP-1"], dependencies)).toBe(0);
    expect(calls).toHaveLength(3);
    expect(errors).toEqual([]);
  });

  it("reports Eww failures and does not reveal or enter the mode after a failed open", async () => {
    const { dependencies, errors, run } = harness([
      commandResult({ exitCode: 1, stderr: "could not open window" }),
    ]);

    expect(await runDrawerController(["open", "--output", "DP-1"], dependencies)).toBe(1);
    expect(run).toHaveBeenCalledOnce();
    expect(errors.join("")).toContain("could not open window");
  });

  it("animates close for only the configured delay and restores default after Eww failures", async () => {
    const sleep = vi.fn(async () => undefined);
    const { calls, dependencies, errors } = harness(
      [
        commandResult({ exitCode: 1, stderr: "update failed" }),
        commandResult({ exitCode: 1, stderr: "close failed" }),
        commandResult(),
      ],
      { sleep },
    );

    expect(await runDrawerController(["close"], dependencies)).toBe(1);
    expect(calls).toEqual([
      {
        command: "eww",
        arguments: ["--config", configDirectory, "update", "drawer_revealed=false"],
      },
      {
        command: "eww",
        arguments: ["--config", configDirectory, "close", "toggl-drawer"],
      },
      { command: "swaymsg", arguments: ["mode", "default"] },
    ]);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(180);
    expect(errors.join("")).toContain("update failed");
    expect(errors.join("")).toContain("close failed");
  });

  it.each([
    ["toggl-drawer: toggl-drawer\n", "close"],
    ["some-other-id: toggl-drawer\n", "open"],
  ])("toggles from exact active window IDs", async (stdout, expectedAction) => {
    const results =
      expectedAction === "close"
        ? [commandResult({ stdout }), commandResult(), commandResult(), commandResult()]
        : [
            commandResult({ stdout }),
            commandResult(),
            commandResult(),
            commandResult({ stdout: '["default"]' }),
          ];
    const { calls, dependencies } = harness(results);

    expect(await runDrawerController(["toggle", "--output", "DP-3"], dependencies)).toBe(0);
    expect(calls[0]).toEqual({
      command: "eww",
      arguments: ["--config", configDirectory, "active-windows"],
    });
    expect(calls[1]?.arguments[2]).toBe(expectedAction === "close" ? "update" : "open");
  });

  it.each([
    [[]],
    [["unknown"]],
    [["open", "--output"]],
    [["open", "--output", ""]],
    [["open", "--output", "DP-1", "extra"]],
  ])("rejects invalid grammar %j without spawning", async (arguments_) => {
    const { dependencies, errors, run } = harness([]);

    expect(await runDrawerController(arguments_, dependencies)).toBe(2);
    expect(run).not.toHaveBeenCalled();
    expect(errors.join("")).toContain("Usage:");
  });
});

interface ExecutedBundle {
  exitCode: number;
  stderr: string;
  stdout: string;
}

function executeBundle(
  path: string,
  arguments_: readonly string[],
  workingDirectory: string,
  environment: NodeJS.ProcessEnv,
): Promise<ExecutedBundle> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [path, ...arguments_], {
      cwd: workingDirectory,
      env: environment,
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
      resolveResult({ exitCode: exitCode ?? 1, stdout, stderr });
    });
  });
}

describe("runtime bundles", () => {
  let temporaryDirectory: string;

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "toggl-waybar-bundles-"));
    const build = await executeBundle(
      join(clientDirectory, "scripts", "build-runtime.mjs"),
      [],
      temporaryDirectory,
      { PATH: "/usr/bin:/bin" },
    );
    expect(build).toMatchObject({ exitCode: 0, stderr: "" });
  });

  afterAll(async () => {
    await rm(temporaryDirectory, { recursive: true });
  });

  it.each([
    ["daemon.mjs", [], 1],
    ["renderer.mjs", [], 0],
    ["toggl-waybar.mjs", ["invalid"], 2],
    ["drawer-controller.mjs", ["invalid"], 2],
  ])(
    "executes %s outside the repository without runtime package imports",
    async (filename, arguments_, exitCode) => {
      const builtPath = join(clientDirectory, "dist", "runtime", filename);
      const copiedPath = join(temporaryDirectory, basename(builtPath));
      await copyFile(builtPath, copiedPath);
      const source = await readFile(copiedPath, "utf8");
      const importSpecifiers = [
        ...source.matchAll(/\bfrom\s+["']([^"']+)["']/g),
        ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
      ].map((match) => match[1]);
      expect(importSpecifiers.every((specifier) => specifier?.startsWith("node:"))).toBe(true);
      expect(source).not.toContain(repositoryDirectory);

      const environment: NodeJS.ProcessEnv = {
        HOME: temporaryDirectory,
        PATH: "/usr/bin:/bin",
        XDG_CONFIG_HOME: join(temporaryDirectory, "config"),
        XDG_RUNTIME_DIR: join(temporaryDirectory, "runtime"),
        XDG_STATE_HOME: join(temporaryDirectory, "state"),
      };
      if (filename === "renderer.mjs") {
        environment.TOGGL_LABEL_MAX_CHARS = "invalid";
      }
      const executed = await executeBundle(copiedPath, arguments_, temporaryDirectory, environment);
      expect(executed.exitCode).toBe(exitCode);
    },
  );
});
