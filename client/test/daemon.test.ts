import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const order: string[] = [];
  return {
    order,
    controlClose: vi.fn(async () => order.push("socket_close")),
    relayStart: vi.fn(() => order.push("relay_start")),
    relayStop: vi.fn(() => order.push("relay_stop")),
    publish: vi.fn(async () => order.push("runtime_publish")),
  };
});

vi.mock("../src/config.js", () => ({
  loadConfig: () => ({
    apiBaseUrl: "http://127.0.0.1:3000",
    labelMaxChars: 12,
    relayToken: "relay-token",
    relayUrl: "ws://127.0.0.1:3001/ws",
    timezone: "Africa/Cairo",
    togglApiToken: "api-token",
  }),
}));

vi.mock("../src/runtime-path.js", () => ({
  runtimePaths: () => ({
    directory: "/runtime/toggl-waybar-live",
    stateFile: "/runtime/toggl-waybar-live/state.json",
    controlSocket: "/runtime/toggl-waybar-live/control.sock",
  }),
}));

vi.mock("../src/preset-file.js", () => ({
  defaultPresetPath: () => "/state/toggl-waybar-live/presets.json",
  loadPresets: async () => {
    mocks.order.push("presets_load");
    return [];
  },
  savePresets: vi.fn(async () => undefined),
}));

vi.mock("../src/runtime-file.js", () => ({ publishRuntimeState: mocks.publish }));

vi.mock("../src/control-server.js", () => ({
  startControlServer: vi.fn(async () => {
    mocks.order.push("socket_start");
    return { path: "/runtime/toggl-waybar-live/control.sock", close: mocks.controlClose };
  }),
}));

vi.mock("../src/toggl-api.js", () => ({
  TogglApi: class {
    fetchToday() {
      mocks.order.push("reconcile_today");
      return Promise.resolve({
        ok: true,
        data: [],
        quota: { remaining: 100, resetsInSeconds: 60 },
      });
    }

    fetchCurrent() {
      mocks.order.push("reconcile_current");
      return Promise.resolve({
        ok: true,
        data: null,
        quota: { remaining: 100, resetsInSeconds: 60 },
      });
    }
  },
}));

vi.mock("../src/relay-client.js", () => ({
  RelayClient: class {
    start = mocks.relayStart;
    stop = mocks.relayStop;
  },
}));

import { startDaemon } from "../src/daemon.js";

beforeEach(() => {
  mocks.order.length = 0;
  vi.clearAllMocks();
});

describe("daemon integration", () => {
  it("starts the private server before reconciliation and shuts resources down in order", async () => {
    const daemon = await startDaemon();

    expect(mocks.order).toEqual([
      "presets_load",
      "socket_start",
      "reconcile_today",
      "reconcile_current",
      "runtime_publish",
      "runtime_publish",
      "relay_start",
    ]);

    await daemon.stop();
    await daemon.done;
    expect(mocks.order.slice(-2)).toEqual(["relay_stop", "socket_close"]);
    expect(mocks.controlClose).toHaveBeenCalledOnce();
  });
});
