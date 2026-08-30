import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
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
const builtinModuleSpecifiers = new Set(
  builtinModules.flatMap((specifier) => [specifier, `node:${specifier}`]),
);

function commandResult(overrides: Partial<DrawerCommandResult> = {}): DrawerCommandResult {
  return { exitCode: 0, stdout: "", stderr: "", ...overrides };
}

function ewwArguments(...arguments_: string[]): string[] {
  return ["--force-wayland", "--config", configDirectory, "--no-daemonize", ...arguments_];
}

function swayOutputs(
  ...outputs: Array<{ active?: boolean; focused?: boolean; name: string }>
): DrawerCommandResult {
  return commandResult({
    stdout: JSON.stringify(outputs.map((output) => ({ active: true, focused: false, ...output }))),
  });
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
      ewwExecutable: "eww",
      revealDurationMilliseconds: 180,
      run,
      sleep: vi.fn(async () => undefined),
      swaySocket: null,
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
      swayOutputs({ name: "DP-1" }, { name: "DP-2", focused: true }),
      commandResult(),
      commandResult(),
      commandResult({ stdout: '["default","toggl-waybar-drawer"]\n' }),
      commandResult(),
    ]);

    expect(await runDrawerController(["open", "--output", "DP-2"], dependencies)).toBe(0);
    expect(calls).toEqual([
      {
        command: "swaymsg",
        arguments: ["-t", "get_outputs", "--raw"],
      },
      {
        command: "eww",
        arguments: ewwArguments("open", "toggl-drawer", "--id", "toggl-drawer", "--screen", "1"),
      },
      {
        command: "eww",
        arguments: ewwArguments("update", "drawer_revealed=true"),
      },
      {
        command: "swaymsg",
        arguments: ["-t", "get_binding_modes", "--raw"],
      },
      { command: "swaymsg", arguments: ["mode", "toggl-waybar-drawer"] },
    ]);
    expect(errors).toEqual([]);
  });

  it("maps the focused active output to Eww's numeric Wayland monitor order", async () => {
    const { calls, dependencies } = harness([
      swayOutputs(
        { active: false, name: "DISABLED-1" },
        { name: "DP-1" },
        { focused: true, name: "HDMI-A-1" },
      ),
      commandResult(),
      commandResult(),
      commandResult({ exitCode: 1, stderr: "binding modes unavailable" }),
    ]);

    expect(await runDrawerController(["open"], dependencies)).toBe(0);
    expect(calls[0]).toEqual({
      command: "swaymsg",
      arguments: ["-t", "get_outputs", "--raw"],
    });
    expect(calls[1]?.arguments).toEqual(
      ewwArguments("open", "toggl-drawer", "--id", "toggl-drawer", "--screen", "1"),
    );
    expect(calls).toHaveLength(4);
  });

  it("pins Eww and the compositor socket when commands originate from the drawer service", async () => {
    const { calls, dependencies } = harness(
      [
        swayOutputs({ focused: true, name: "DP-1" }),
        commandResult(),
        commandResult(),
        commandResult({ stdout: '["default"]' }),
      ],
      {
        ewwExecutable: "/home/test/.local/bin/eww",
        swaySocket: "/run/user/1000/scroll-ipc.sock",
      },
    );

    expect(await runDrawerController(["open"], dependencies)).toBe(0);
    expect(calls[0]).toEqual({
      command: "swaymsg",
      arguments: ["--socket", "/run/user/1000/scroll-ipc.sock", "-t", "get_outputs", "--raw"],
    });
    expect(calls[1]?.command).toBe("/home/test/.local/bin/eww");
    expect(calls[3]?.arguments).toEqual([
      "--socket",
      "/run/user/1000/scroll-ipc.sock",
      "-t",
      "get_binding_modes",
      "--raw",
    ]);
  });

  it.each([
    ["not JSON"],
    [JSON.stringify({ active: true, focused: true, name: "DP-1" })],
    [JSON.stringify([{ active: true, focused: true, name: "" }])],
    [JSON.stringify([{ active: true, focused: false, name: "DP-1" }])],
  ])("rejects malformed focused output data %j", async (stdout) => {
    const { dependencies, errors, run } = harness([commandResult({ stdout })]);

    expect(await runDrawerController(["open"], dependencies)).toBe(1);
    expect(run).toHaveBeenCalledOnce();
    expect(errors.join("")).toContain("focused Sway output");
  });

  it("does not let optional mode discovery fail an otherwise successful open", async () => {
    const { calls, dependencies, errors } = harness([
      swayOutputs({ focused: true, name: "DP-1" }),
      commandResult(),
      commandResult(),
      commandResult({ stdout: '{"default":true}' }),
    ]);

    expect(await runDrawerController(["open", "--output", "DP-1"], dependencies)).toBe(0);
    expect(calls).toHaveLength(4);
    expect(errors).toEqual([]);
  });

  it("reports Eww failures and does not reveal or enter the mode after a failed open", async () => {
    const { dependencies, errors, run } = harness([
      swayOutputs({ focused: true, name: "DP-1" }),
      commandResult({ exitCode: 1, stderr: "could not open window" }),
    ]);

    expect(await runDrawerController(["open", "--output", "DP-1"], dependencies)).toBe(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(errors.join("")).toContain("could not open window");
  });

  it("cleans up a created overlay after reveal failure without hiding the original error", async () => {
    const { calls, dependencies, errors } = harness([
      swayOutputs({ focused: true, name: "DP-1" }),
      commandResult(),
      commandResult({ exitCode: 1, stderr: "reveal failed" }),
      commandResult({ exitCode: 1, stderr: "cleanup close failed" }),
      commandResult({ exitCode: 1, stderr: "cleanup mode failed" }),
    ]);

    expect(await runDrawerController(["open", "--output", "DP-1"], dependencies)).toBe(1);
    expect(calls).toEqual([
      {
        command: "swaymsg",
        arguments: ["-t", "get_outputs", "--raw"],
      },
      {
        command: "eww",
        arguments: ewwArguments("open", "toggl-drawer", "--id", "toggl-drawer", "--screen", "0"),
      },
      {
        command: "eww",
        arguments: ewwArguments("update", "drawer_revealed=true"),
      },
      {
        command: "eww",
        arguments: ewwArguments("close", "toggl-drawer"),
      },
      { command: "swaymsg", arguments: ["mode", "default"] },
    ]);
    expect(errors.join("\n")).toContain("reveal failed");
    expect(errors.join("\n")).toContain("cleanup close failed");
    expect(errors.join("\n")).toContain("cleanup mode failed");
    expect(errors.join("\n").indexOf("reveal failed")).toBeLessThan(
      errors.join("\n").indexOf("cleanup close failed"),
    );
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
        arguments: ewwArguments("update", "drawer_revealed=false"),
      },
      {
        command: "eww",
        arguments: ewwArguments("close", "toggl-drawer"),
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
            swayOutputs({ focused: true, name: "DP-3" }),
            commandResult(),
            commandResult(),
            commandResult({ stdout: '["default"]' }),
          ];
    const { calls, dependencies } = harness(results);

    expect(await runDrawerController(["toggle", "--output", "DP-3"], dependencies)).toBe(0);
    expect(calls[0]).toEqual({
      command: "eww",
      arguments: ewwArguments("active-windows"),
    });
    const actionCall = calls.find((call) => call.command === "eww" && call !== calls[0]);
    expect(actionCall?.arguments).toContain(expectedAction === "close" ? "update" : "open");
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
      const commonJsSpecifiers = [
        ...source.matchAll(/\b(?:require|__require)\s*\(\s*["']([^"']+)["']\s*\)/g),
      ].map((match) => match[1]);
      expect(
        [...importSpecifiers, ...commonJsSpecifiers].filter(
          (specifier) => !specifier || !builtinModuleSpecifiers.has(specifier),
        ),
      ).toEqual([]);
      expect(source).not.toContain("bufferutil");
      expect(source).not.toContain("utf-8-validate");
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
      expect(`${executed.stdout}\n${executed.stderr}`).not.toContain("Dynamic require of");
      if (filename === "daemon.mjs") {
        expect(executed.stderr).toBe("");
        expect(JSON.parse(executed.stdout)).toMatchObject({ event: "daemon_start_failed" });
      } else if (filename === "renderer.mjs") {
        expect(executed.stderr).toBe("");
        expect(JSON.parse(executed.stdout)).toMatchObject({ class: ["offline"] });
      } else {
        expect(executed.stderr).toContain("Usage:");
      }
    },
  );
});

describe("Eww source assets", () => {
  it("gives every command button enough time to complete", async () => {
    const source = await readFile(join(repositoryDirectory, "eww", "eww.yuck"), "utf8");
    const lines = source.split("\n");
    const commandLines = lines
      .map((line, index) => ({ index, line }))
      .filter(({ line }) => line.includes(":onclick"));

    expect(commandLines).toHaveLength(4);
    for (const { index } of commandLines) {
      expect(
        lines.slice(Math.max(0, index - 3), index).some((line) => line.includes(":timeout")),
      ).toBe(true);
    }
    expect(source.match(/:timeout "15s"/g)).toHaveLength(3);
    expect(source.match(/:timeout "2s"/g)).toHaveLength(1);
  });

  it("keeps the overlay keyboard-neutral and its long text visible", async () => {
    const [yuck, scss] = await Promise.all([
      readFile(join(repositoryDirectory, "eww", "eww.yuck"), "utf8"),
      readFile(join(repositoryDirectory, "eww", "eww.scss"), "utf8"),
    ]);
    const panelRule = scss.match(/\.toggl-panel\s*\{([^}]*)\}/)?.[1] ?? "";
    const presetRow = yuck.slice(
      yuck.indexOf("(defwidget preset-row"),
      yuck.indexOf("(defwidget recent-presets"),
    );

    expect(yuck).toContain(":focusable false");
    expect(yuck).not.toMatch(/\{[^"\n]*(?:==|!=)\s+null/);
    expect(yuck).toContain(":width 720");
    expect(yuck).not.toContain(":limit-width");
    expect(yuck.match(/:show-truncated false/g)).toHaveLength(
      yuck.match(/\(label\b/g)?.length ?? 0,
    );
    expect(yuck.match(/:wrap true/g)).toHaveLength(7);
    expect(presetRow).not.toContain("toggl_view");
    expect(panelRule).not.toContain("min-width");
    expect(scss).toMatch(/window\s*\{[^}]*background-color:\s*transparent;/s);
    expect(scss).not.toMatch(/font-weight:\s*(?:650|750)/);
  });
});

describe("package metadata", () => {
  it("locks the drawer bin and the shared esbuild toolchain version", async () => {
    const [rootPackageSource, clientPackageSource, lockSource] = await Promise.all([
      readFile(join(repositoryDirectory, "package.json"), "utf8"),
      readFile(join(clientDirectory, "package.json"), "utf8"),
      readFile(join(repositoryDirectory, "package-lock.json"), "utf8"),
    ]);
    const rootPackage = JSON.parse(rootPackageSource);
    const clientPackage = JSON.parse(clientPackageSource);
    const lock = JSON.parse(lockSource);

    expect(rootPackage.devDependencies.esbuild).toBe("0.28.1");
    expect(lock.packages[""].devDependencies.esbuild).toBe("0.28.1");
    expect(lock.packages.client.bin).toEqual(clientPackage.bin);
    expect(lock.packages.client.bin["toggl-waybar-drawer"]).toBe("dist/drawer-controller.js");
  });
});
