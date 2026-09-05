import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const deferred = () => {
    let resolve!: (value: unknown) => void;
    const promise = new Promise<unknown>((fulfill) => {
      resolve = fulfill;
    });
    return { promise, resolve };
  };
  const gates = {
    create: deferred(),
    maintenanceCurrent: deferred(),
    persistence: deferred(),
    runtime: deferred(),
  };
  const order: string[] = [];
  const state = {
    fetchCurrentCalls: 0,
    provider: null as { handle(request: unknown): Promise<unknown> } | null,
  };
  const reset = (): void => {
    gates.create = deferred();
    gates.maintenanceCurrent = deferred();
    gates.persistence = deferred();
    gates.runtime = deferred();
    order.length = 0;
    state.fetchCurrentCalls = 0;
    state.provider = null;
  };
  return {
    gates,
    order,
    reset,
    state,
    controlClose: vi.fn(async () => order.push("socket_close")),
    relayStart: vi.fn(() => order.push("relay_start")),
    relayStop: vi.fn(() => order.push("relay_stop")),
    publish: vi.fn(async () => {
      order.push("runtime_publish_start");
      await gates.runtime.promise;
      order.push("runtime_publish_end");
    }),
  };
});

const preset = {
  id: "11111111-1111-4111-8111-111111111111",
  workspaceId: "202",
  description: "Review",
  projectId: "404",
  taskId: null,
  tagIds: ["505"],
  tags: ["focus"],
  billable: false,
  projectColor: "#c9806b",
  projectName: "Internal",
  taskName: null,
  lastUsedAt: "2026-08-27T10:00:00Z",
};

const createdEntry = {
  id: "101",
  workspaceId: "202",
  userId: "303",
  projectId: "404",
  projectColor: "#c9806b",
  projectName: "Internal",
  description: "Review",
  start: "2026-08-30T12:00:00Z",
  stop: null,
  durationSeconds: null,
  taskId: null,
  taskName: null,
  tagIds: ["505"],
  tags: ["focus"],
  billable: false,
  updatedAt: null,
};

const success = (data: unknown) => ({
  ok: true,
  data,
  quota: { remaining: 100, resetsInSeconds: 60 },
});

vi.mock("../src/config.js", () => ({
  loadConfig: () => ({
    apiBaseUrl: "http://127.0.0.1:3000",
    labelMaxChars: 12,
    relayToken: "relay-token",
    relayUrl: "ws://127.0.0.1:3001/ws",
    timezone: "Africa/Cairo",
    weekStart: 0,
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
    return [preset];
  },
  savePresets: vi.fn(async () => {
    mocks.order.push("persistence_start");
    await mocks.gates.persistence.promise;
    mocks.order.push("persistence_end");
  }),
}));

vi.mock("../src/runtime-file.js", () => ({ publishRuntimeState: mocks.publish }));

vi.mock("../src/control-server.js", () => ({
  startControlServer: vi.fn(async ({ provider }: { provider: unknown }) => {
    mocks.order.push("socket_start");
    mocks.state.provider = provider as { handle(request: unknown): Promise<unknown> };
    return { path: "/runtime/toggl-waybar-live/control.sock", close: mocks.controlClose };
  }),
}));

vi.mock("../src/toggl-api.js", () => ({
  TogglApi: class {
    fetchToday() {
      mocks.order.push("reconcile_today");
      return Promise.resolve(success([]));
    }

    fetchCurrent() {
      mocks.state.fetchCurrentCalls += 1;
      if (mocks.state.fetchCurrentCalls === 1) {
        mocks.order.push("reconcile_current");
        return Promise.resolve(success(null));
      }
      mocks.order.push("maintenance_current_start");
      return mocks.gates.maintenanceCurrent.promise;
    }

    fetchMonth() {
      mocks.order.push("reconcile_month");
      return Promise.resolve(success([]));
    }

    createRunningEntry() {
      mocks.order.push("mutation_create_start");
      return mocks.gates.create.promise;
    }

    stopTimeEntry() {
      return Promise.resolve(success(createdEntry));
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

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  mocks.reset();
  vi.clearAllMocks();
});

describe("daemon integration", () => {
  it("quiesces resources and drains maintenance, mutations, persistence, and publication", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00Z"));
    const writes: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      const starting = startDaemon();
      await flushMicrotasks();
      expect(mocks.order).toContain("reconcile_today");
      expect(mocks.order).not.toContain("reconcile_current");

      await vi.advanceTimersByTimeAsync(1_000);
      expect(mocks.order).toContain("reconcile_current");
      expect(mocks.order).not.toContain("reconcile_month");

      await vi.advanceTimersByTimeAsync(1_000);
      const daemon = await starting;
      expect(mocks.order.indexOf("socket_start")).toBeLessThan(
        mocks.order.indexOf("reconcile_today"),
      );
      expect(mocks.order.indexOf("reconcile_today")).toBeLessThan(
        mocks.order.indexOf("reconcile_current"),
      );
      expect(mocks.order.indexOf("reconcile_current")).toBeLessThan(
        mocks.order.indexOf("reconcile_month"),
      );
      expect(mocks.order.indexOf("reconcile_month")).toBeLessThan(
        mocks.order.indexOf("relay_start"),
      );

      await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);
      expect(mocks.order).toContain("maintenance_current_start");

      const mutation = mocks.state.provider?.handle({
        version: 1,
        type: "resume",
        presetId: preset.id,
      });
      expect(mutation).toBeDefined();
      await flushMicrotasks();
      expect(mocks.order).not.toContain("mutation_create_start");

      const rejected = mocks.state.provider?.handle({
        version: 1,
        type: "resume",
        presetId: preset.id,
      });
      await expect(rejected).resolves.toMatchObject({
        outcome: "failed",
        error: "command_busy",
      });
      expect(mocks.order.filter((event) => event === "mutation_create_start")).toHaveLength(0);

      let stopSettled = false;
      const stopping = daemon.stop().then(() => {
        stopSettled = true;
      });
      await flushMicrotasks();
      expect(mocks.order).toContain("relay_stop");
      expect(mocks.order).toContain("socket_close");
      expect(stopSettled).toBe(false);

      mocks.gates.maintenanceCurrent.resolve(success(null));
      await flushMicrotasks();
      expect(stopSettled).toBe(false);
      expect(writes.some((line) => line.includes('"event":"reconciliation_failed"'))).toBe(false);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(mocks.order).toContain("mutation_create_start");

      mocks.gates.create.resolve(success(createdEntry));
      await flushMicrotasks();
      expect(mocks.order).toContain("persistence_start");
      expect(stopSettled).toBe(false);

      mocks.gates.persistence.resolve(undefined);
      await mutation;
      await flushMicrotasks();
      expect(mocks.order).toContain("persistence_end");
      expect(stopSettled).toBe(false);

      mocks.gates.runtime.resolve(undefined);
      await stopping;
      await daemon.done;
      expect(stopSettled).toBe(true);
      expect(mocks.order.filter((event) => event === "mutation_create_start")).toHaveLength(1);
      expect(mocks.order.at(-1)).toBe("runtime_publish_end");
    } finally {
      write.mockRestore();
      vi.useRealTimers();
    }
  });
});
