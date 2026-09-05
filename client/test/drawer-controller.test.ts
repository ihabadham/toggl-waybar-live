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
        arguments: ewwArguments("update", "today_expanded=false"),
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
      commandResult(),
      commandResult({ exitCode: 1, stderr: "binding modes unavailable" }),
    ]);

    expect(await runDrawerController(["open"], dependencies)).toBe(0);
    expect(calls[0]).toEqual({
      command: "swaymsg",
      arguments: ["-t", "get_outputs", "--raw"],
    });
    expect(calls[1]?.arguments).toEqual(ewwArguments("update", "today_expanded=false"));
    expect(calls[2]?.arguments).toEqual(
      ewwArguments("open", "toggl-drawer", "--id", "toggl-drawer", "--screen", "1"),
    );
    expect(calls).toHaveLength(5);
  });

  it("pins Eww and the compositor socket when commands originate from the drawer service", async () => {
    const { calls, dependencies } = harness(
      [
        swayOutputs({ focused: true, name: "DP-1" }),
        commandResult(),
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
    expect(calls[1]).toEqual({
      command: "/home/test/.local/bin/eww",
      arguments: ewwArguments("update", "today_expanded=false"),
    });
    expect(calls[2]?.command).toBe("/home/test/.local/bin/eww");
    expect(calls[4]?.arguments).toEqual([
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
      commandResult(),
      commandResult({ stdout: '{"default":true}' }),
    ]);

    expect(await runDrawerController(["open", "--output", "DP-1"], dependencies)).toBe(0);
    expect(calls).toHaveLength(5);
    expect(errors).toEqual([]);
  });

  it("does not create a window when resetting the Today disclosure fails", async () => {
    const { calls, dependencies, errors } = harness([
      swayOutputs({ focused: true, name: "DP-1" }),
      commandResult({ exitCode: 1, stderr: "state update failed" }),
    ]);

    expect(await runDrawerController(["open", "--output", "DP-1"], dependencies)).toBe(1);
    expect(calls).toEqual([
      {
        command: "swaymsg",
        arguments: ["-t", "get_outputs", "--raw"],
      },
      {
        command: "eww",
        arguments: ewwArguments("update", "today_expanded=false"),
      },
    ]);
    expect(errors.join("")).toContain("Unable to reset the Today disclosure");
    expect(errors.join("")).toContain("state update failed");
  });

  it("reports Eww failures and does not reveal or enter the mode after a failed open", async () => {
    const { dependencies, errors, run } = harness([
      swayOutputs({ focused: true, name: "DP-1" }),
      commandResult(),
      commandResult({ exitCode: 1, stderr: "could not open window" }),
    ]);

    expect(await runDrawerController(["open", "--output", "DP-1"], dependencies)).toBe(1);
    expect(run).toHaveBeenCalledTimes(3);
    expect(errors.join("")).toContain("could not open window");
  });

  it("cleans up a created overlay after reveal failure without hiding the original error", async () => {
    const { calls, dependencies, errors } = harness([
      swayOutputs({ focused: true, name: "DP-1" }),
      commandResult(),
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
        arguments: ewwArguments("update", "today_expanded=false"),
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
            commandResult(),
            commandResult({ stdout: '["default"]' }),
          ];
    const { calls, dependencies } = harness(results);

    expect(await runDrawerController(["toggle", "--output", "DP-3"], dependencies)).toBe(0);
    expect(calls[0]).toEqual({
      command: "eww",
      arguments: ewwArguments("active-windows"),
    });
    if (expectedAction === "close") {
      expect(calls).toEqual([
        { command: "eww", arguments: ewwArguments("active-windows") },
        {
          command: "eww",
          arguments: ewwArguments("update", "drawer_revealed=false"),
        },
        { command: "eww", arguments: ewwArguments("close", "toggl-drawer") },
        { command: "swaymsg", arguments: ["mode", "default"] },
      ]);
    } else {
      expect(calls).toEqual([
        { command: "eww", arguments: ewwArguments("active-windows") },
        {
          command: "swaymsg",
          arguments: ["-t", "get_outputs", "--raw"],
        },
        {
          command: "eww",
          arguments: ewwArguments("update", "today_expanded=false"),
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
          command: "swaymsg",
          arguments: ["-t", "get_binding_modes", "--raw"],
        },
      ]);
    }
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

function sourceSection(source: string, startMarker: string, endMarker?: string): string {
  const start = source.indexOf(startMarker);
  if (start === -1) {
    throw new Error(`Missing source marker ${startMarker}`);
  }
  const end = endMarker === undefined ? source.length : source.indexOf(endMarker, start + 1);
  if (end === -1) {
    throw new Error(`Missing source marker ${endMarker}`);
  }
  return source.slice(start, end);
}

describe("Eww source assets", () => {
  it("gives every command button a timeout, including the local Today toggle", async () => {
    const yuck = await readFile(join(repositoryDirectory, "eww", "eww.yuck"), "utf8");
    const controls = sourceSection(yuck, "(defwidget primary-controls", "(defwidget preset-row");
    const preset = sourceSection(yuck, "(defwidget preset-row", "(defwidget quick-resume");
    const glance = sourceSection(yuck, "(defwidget glance-and-history", "(defwidget toggl-panel");
    const window = sourceSection(yuck, "(defwindow toggl-drawer");

    expect(yuck.match(/:onclick/g)).toHaveLength(5);
    expect(controls.match(/:timeout "15s"/g)).toHaveLength(2);
    expect(preset).toContain(':timeout "15s"');
    expect(glance).toContain(':timeout "2s"');
    expect(glance).toContain(
      `:onclick "\${EWW_CMD} update today_expanded=\${today_expanded ? false : true}"`,
    );
    expect(window).toContain(':timeout "2s"');
  });

  it("defines the fallback, first-map-safe conditional surfaces, and action-first hierarchy", async () => {
    const yuck = await readFile(join(repositoryDirectory, "eww", "eww.yuck"), "utf8");
    const initialLiteral = yuck.match(/:initial\s+("(?:\\.|[^"\\])*")/)?.[1];
    expect(initialLiteral).toBeDefined();
    const initialJson = JSON.parse(initialLiteral ?? '"{}"');
    expect(JSON.parse(initialJson)).toEqual({
      version: 1,
      status: "offline",
      connection: "offline",
      confidence: "uncertain",
      current: null,
      today: "00:00:00",
      todayEntryCount: 0,
      todayEntryCountLabel: "0 entries",
      todayEntries: [],
      todayEntriesOmitted: 0,
      todayEntriesOmittedLabel: "",
      week: { availability: "unavailable", value: "—", cue: "" },
      month: { availability: "unavailable", value: "—", cue: "" },
      pending: null,
      error: "Toggl daemon unavailable",
      presets: [],
    });

    const panel = sourceSection(yuck, "(defwidget toggl-panel", "(defwindow toggl-drawer");
    const current = sourceSection(
      yuck,
      "(defwidget current-summary",
      "(defwidget primary-controls",
    );
    const quickResume = sourceSection(
      yuck,
      "(defwidget quick-resume",
      "(defwidget today-entry-row",
    );
    const presetRow = sourceSection(yuck, "(defwidget preset-row", "(defwidget quick-resume");
    const glance = sourceSection(yuck, "(defwidget glance-and-history", "(defwidget toggl-panel");

    expect(yuck).toContain("(defvar today_expanded false)");
    expect(current).toContain(':reveal {jq(toggl_view, ".current != null")}');
    expect(current).toContain(
      ':reveal {jq(toggl_view, ".current == null and .status == \\"idle\\"")}',
    );
    expect(current).toContain(
      ':reveal {jq(toggl_view, ".current == null and .status != \\"idle\\"")}',
    );
    expect(current).not.toContain("(stack");
    expect(yuck).not.toContain(":visible {");
    expect(current).toContain('"RUNNING NOW"');
    expect(current).toContain('"TIMER IDLE"');
    expect(current).toContain('"STATE UNAVAILABLE"');
    expect(current).toContain('"Timer state is unavailable"');
    expect(quickResume).toContain('"QUICK RESUME"');
    expect(quickResume).toContain(':class "preset-list"');
    expect(quickResume).toContain(':active {toggl_view.status == "idle"');
    expect(presetRow).toContain(':class "play-affordance"');
    expect(yuck).not.toContain("RECENT");
    expect(yuck).not.toMatch(/\/\s*8\b/);
    expect(glance).toContain('text "THIS WEEK"');
    expect(glance).toContain("toggl_view.week.value");

    const currentIndex = panel.indexOf("(current-summary)");
    const controlsIndex = panel.indexOf("(primary-controls)");
    const scrollIndex = panel.indexOf("(scroll");
    const quickResumeIndex = panel.indexOf("(quick-resume)");
    const glanceIndex = panel.indexOf("(glance-and-history)");
    expect([currentIndex, controlsIndex, scrollIndex, quickResumeIndex, glanceIndex]).not.toContain(
      -1,
    );
    expect(currentIndex).toBeLessThan(controlsIndex);
    expect(controlsIndex).toBeLessThan(scrollIndex);
    expect(scrollIndex).toBeLessThan(quickResumeIndex);
    expect(quickResumeIndex).toBeLessThan(glanceIndex);
    expect(panel).toContain(":vscroll true");
    expect(panel).toContain(":hscroll false");

    expect(glance).toContain(':class "today-toggle"');
    expect(glance).toContain(':text "TODAY"');
    expect(glance).toContain("toggl_view.todayEntryCountLabel");
    expect(glance).toContain(":reveal today_expanded");
    expect(glance).toContain(':transition "slidedown"');
    expect(glance).toContain(':duration "150ms"');
    expect(glance).toContain(":reveal {toggl_view.todayEntryCount == 0}");
    expect(glance).toContain("toggl_view.todayEntries");
    expect(glance).toContain("toggl_view.todayEntriesOmittedLabel");
    expect(glance).toContain(`:class "period-card month-card \${toggl_view.month.availability}"`);
    expect(glance).toContain("toggl_view.month.value");
    expect(glance).toContain("toggl_view.month.cue");
  });

  it("keeps dynamic rows local and every user-provided label fully visible", async () => {
    const yuck = await readFile(join(repositoryDirectory, "eww", "eww.yuck"), "utf8");
    const projectContext = sourceSection(
      yuck,
      "(defwidget project-context",
      "(defwidget connection-status",
    );
    const current = sourceSection(
      yuck,
      "(defwidget current-summary",
      "(defwidget primary-controls",
    );
    const controls = sourceSection(yuck, "(defwidget primary-controls", "(defwidget preset-row");
    const presetRow = sourceSection(yuck, "(defwidget preset-row", "(defwidget quick-resume");
    const todayEntryRow = sourceSection(
      yuck,
      "(defwidget today-entry-row",
      "(defwidget glance-and-history",
    );

    expect(presetRow).toContain("[preset]");
    expect(presetRow).toContain("preset.");
    expect(todayEntryRow).toContain("[entry]");
    expect(todayEntryRow).toContain("entry.");
    for (const row of [presetRow, todayEntryRow]) {
      expect(row).not.toContain("toggl_view");
      expect(row).not.toContain("today_expanded");
    }

    expect(yuck.match(/:show-truncated false/g)).toHaveLength(
      yuck.match(/\(label\b/g)?.length ?? 0,
    );
    expect(projectContext).toContain(':valign "center"');
    expect(todayEntryRow).toContain(':class "timeline-marker"');
    expect(todayEntryRow).toContain(':valign "start"');
    expect(projectContext).toMatch(/:wrap true[\s\S]*:text \{context\}/);
    expect(current).toMatch(/:wrap true[\s\S]*:text \{toggl_view\.current\?\.label/);
    expect(controls).toMatch(/:wrap true[\s\S]*:text \{toggl_view\.error/);
    expect(presetRow).toMatch(/:wrap true[\s\S]*:text \{preset\.label\}/);
    expect(todayEntryRow).toMatch(/:wrap true[\s\S]*:text \{entry\.label\}/);
  });

  it("keeps the overlay portable, transparent, wide, and keyboard-neutral", async () => {
    const [yuck, scss] = await Promise.all([
      readFile(join(repositoryDirectory, "eww", "eww.yuck"), "utf8"),
      readFile(join(repositoryDirectory, "eww", "eww.scss"), "utf8"),
    ]);
    const panelRule = scss.match(/\.toggl-panel\s*\{([^}]*)\}/)?.[1] ?? "";
    const primaryButtonRule = scss.match(/\.primary-button\s*\{([^}]*)\}/)?.[1] ?? "";
    const placeholders = [...new Set(yuck.match(/__[A-Z][A-Z_]+__/g) ?? [])].sort();

    expect(yuck).toContain(":focusable false");
    expect(yuck).not.toMatch(/\{[^"\n]*(?:==|!=)\s+null/);
    expect(yuck).toContain(":width 720");
    expect(yuck).not.toContain(":limit-width");
    expect(placeholders).toEqual([
      "__TOGGL_WAYBAR_DRAWER_EXECUTABLE__",
      "__TOGGL_WAYBAR_EXECUTABLE__",
    ]);
    expect(panelRule).not.toContain("min-width");
    expect(primaryButtonRule).toContain("background-color: $primary-fill");
    expect(primaryButtonRule).toContain("color: $text");
    expect(primaryButtonRule).not.toContain("#302021");
    expect(scss).toMatch(/window\s*\{[^}]*background-color:\s*transparent;/s);
    expect(scss).toMatch(/\.drawer-backdrop,[^{]*\{[^}]*background-color:\s*transparent;/s);
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
