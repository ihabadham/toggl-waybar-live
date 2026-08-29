import type { RelayMessage } from "@toggl-waybar-live/shared";
import { describe, expect, it, vi } from "vitest";

import { ClientCoordinator, type CoordinatorApi } from "../src/coordinator.js";
import type { ResumePreset } from "../src/presets.js";
import { createState, setConnection } from "../src/state.js";
import type { ApiResult, RichTogglEntry } from "../src/toggl-api.js";

const presetId = "11111111-1111-4111-8111-111111111111";
const now = new Date("2026-08-27T12:00:00Z");
const quota = { remaining: 50, resetsInSeconds: 600 };

function entry(overrides: Partial<RichTogglEntry> = {}): RichTogglEntry {
  return {
    id: "101",
    workspaceId: "202",
    userId: "303",
    projectId: "404",
    projectName: "Internal",
    description: "Review",
    start: now.toISOString(),
    stop: null,
    durationSeconds: null,
    taskId: null,
    taskName: null,
    tagIds: ["505"],
    tags: ["focus"],
    billable: false,
    updatedAt: null,
    ...overrides,
  };
}

function preset(overrides: Partial<ResumePreset> = {}): ResumePreset {
  return {
    id: presetId,
    workspaceId: "202",
    description: "Review",
    projectId: "404",
    taskId: null,
    tagIds: ["505"],
    tags: ["focus"],
    billable: false,
    projectName: "Internal",
    taskName: null,
    lastUsedAt: "2026-08-27T10:00:00Z",
    ...overrides,
  };
}

function success<T>(data: T): ApiResult<T> {
  return { ok: true, data, quota };
}

function failure(
  overrides: Partial<Extract<ApiResult<never>, { ok: false }>> = {},
): Extract<ApiResult<never>, { ok: false }> {
  return {
    ok: false,
    error: "request_failed",
    mayHaveSucceeded: false,
    permanent: false,
    quota,
    status: 500,
    ...overrides,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

function runningSnapshot(value: RichTogglEntry): RelayMessage {
  return {
    version: 1,
    type: "snapshot",
    snapshot: {
      status: "running",
      entryId: value.id,
      workspaceId: value.workspaceId,
      projectId: value.projectId,
      description: value.description,
      start: value.start,
      eventId: "10",
      eventCreatedAt: "2026-08-27T12:00:01Z",
    },
  };
}

function api(overrides: Partial<CoordinatorApi> = {}): CoordinatorApi {
  return {
    fetchToday: vi.fn(async () => success([])),
    fetchCurrent: vi.fn(async () => success(null)),
    createRunningEntry: vi.fn(async () => success(entry())),
    stopTimeEntry: vi.fn(async (_workspaceId, entryId) =>
      success(
        entry({
          id: entryId,
          stop: "2026-08-27T12:10:00Z",
          durationSeconds: 600,
        }),
      ),
    ),
    ...overrides,
  };
}

function coordinator(
  apiValue: CoordinatorApi,
  options: {
    connected?: boolean;
    confidence?: "confirmed" | "uncertain";
    initialPresets?: ResumePreset[];
    initialCurrent?: RichTogglEntry | null;
    monotonicNow?: () => number;
    persistPresets?: (presets: readonly ResumePreset[]) => Promise<void>;
    quotaRecord?: (result: ApiResult<unknown>, now: number) => void;
  } = {},
): ClientCoordinator {
  let initialState = createState("2026-08-27");
  if (options.connected ?? true) {
    initialState = setConnection(initialState, "connected");
  }
  const instance = new ClientCoordinator({
    api: apiValue,
    timezone: "Africa/Cairo",
    quotaGate: { record: options.quotaRecord ?? vi.fn() },
    now: () => now,
    ...(options.monotonicNow === undefined ? {} : { monotonicNow: options.monotonicNow }),
    initialState,
    initialConfidence: options.confidence ?? "confirmed",
    initialPresets: options.initialPresets ?? [preset()],
    ...(options.persistPresets === undefined ? {} : { persistPresets: options.persistPresets }),
  });
  if (options.initialCurrent) {
    instance.applyRelay(runningSnapshot(options.initialCurrent));
  }
  return instance;
}

describe("client coordinator", () => {
  it("marks disconnected relay state unconfirmed until REST or relay confirms it", () => {
    const instance = coordinator(api());
    instance.setConnection("stale");
    expect(instance.snapshot().confidence).toBe("uncertain");
    instance.applyRelay(runningSnapshot(entry()));
    expect(instance.snapshot().confidence).toBe("confirmed");
  });

  it("serializes mutations and suppresses Toggle from ingress monotonic time", async () => {
    const create = deferred<ApiResult<RichTogglEntry>>();
    const createRunningEntry = vi.fn(() => create.promise);
    const times = [100, 200];
    const instance = coordinator(api({ createRunningEntry }), {
      monotonicNow: () => times.shift() ?? 200,
    });

    const first = instance.toggle();
    const second = instance.toggle();
    await vi.waitFor(() => expect(createRunningEntry).toHaveBeenCalledTimes(1));
    create.resolve(success(entry()));

    await expect(first).resolves.toMatchObject({ outcome: "resumed" });
    await expect(second).resolves.toMatchObject({ outcome: "duplicate_suppressed" });
    expect(createRunningEntry).toHaveBeenCalledTimes(1);
  });

  it("confirms stale state before choosing the Toggle action", async () => {
    const current = entry({ id: "400" });
    const confirmation = deferred<ApiResult<RichTogglEntry | null>>();
    const fetchCurrent = vi.fn(() => confirmation.promise);
    const stopTimeEntry = vi.fn(async () =>
      success(entry({ ...current, stop: now.toISOString() })),
    );
    const instance = coordinator(api({ fetchCurrent, stopTimeEntry }), {
      connected: false,
      confidence: "uncertain",
    });

    const command = instance.toggle();
    expect(stopTimeEntry).not.toHaveBeenCalled();
    confirmation.resolve(success(current));
    await expect(command).resolves.toMatchObject({ outcome: "stopped" });
    expect(fetchCurrent).toHaveBeenCalledTimes(1);
    expect(stopTimeEntry).toHaveBeenCalledWith("202", "400");
  });

  it("discards background timer data after either a relay revision or mutation acceptance", async () => {
    const first = deferred<ApiResult<RichTogglEntry | null>>();
    const fetchCurrent = vi.fn(() => first.promise);
    const instance = coordinator(api({ fetchCurrent }), { initialPresets: [] });
    const reconciliation = instance.reconcile("current");
    instance.applyRelay(runningSnapshot(entry({ id: "external" })));
    first.resolve(success(null));
    await expect(reconciliation).resolves.toBe(false);
    expect(instance.snapshot().current?.id).toBe("external");

    const second = deferred<ApiResult<RichTogglEntry | null>>();
    fetchCurrent.mockImplementationOnce(() => second.promise);
    const nextReconciliation = instance.reconcile("current");
    const stop = instance.stop();
    second.resolve(success(null));
    await expect(nextReconciliation).resolves.toBe(false);
    await stop;
  });

  it("does not start background reconciliation while a mutation is accepted", async () => {
    const created = deferred<ApiResult<RichTogglEntry>>();
    const fetchCurrent = vi.fn(async () => success(null));
    const instance = coordinator(
      api({ createRunningEntry: vi.fn(() => created.promise), fetchCurrent }),
    );

    const command = instance.resume();
    await vi.waitFor(() => expect(instance.snapshot().pending).toBe("resuming"));
    await expect(instance.reconcile("current")).resolves.toBe(false);
    expect(fetchCurrent).not.toHaveBeenCalled();
    created.resolve(success(entry()));
    await command;
  });

  it("preserves an externally started timer across a late local stop result", async () => {
    const stopped = deferred<ApiResult<RichTogglEntry>>();
    const original = entry({ id: "101" });
    const external = entry({ id: "202", description: "External" });
    const instance = coordinator(api({ stopTimeEntry: vi.fn(() => stopped.promise) }), {
      initialCurrent: original,
    });

    const command = instance.stop();
    await vi.waitFor(() => expect(instance.snapshot().pending).toBe("stopping"));
    instance.applyRelay(runningSnapshot(external));
    stopped.resolve(success(entry({ ...original, stop: now.toISOString(), durationSeconds: 1 })));

    await expect(command).resolves.toMatchObject({ outcome: "stopped" });
    expect(instance.snapshot().current?.id).toBe("202");
  });

  it("keeps an external resume conflict and reconciles instead of installing the create", async () => {
    const created = deferred<ApiResult<RichTogglEntry>>();
    const external = entry({ id: "202", description: "External" });
    const fetchCurrent = vi.fn(async () => success(external));
    const instance = coordinator(
      api({ createRunningEntry: vi.fn(() => created.promise), fetchCurrent }),
    );

    const command = instance.resume();
    await vi.waitFor(() => expect(instance.snapshot().pending).toBe("resuming"));
    instance.applyRelay(runningSnapshot(external));
    created.resolve(success(entry({ id: "303" })));

    await expect(command).resolves.toMatchObject({ outcome: "resumed" });
    expect(instance.snapshot().current?.id).toBe("202");
    expect(fetchCurrent).toHaveBeenCalledTimes(1);
  });

  it("makes webhook echoes idempotent and rejects late resurrection after local stop", async () => {
    const original = entry();
    const instance = coordinator(api(), { initialCurrent: original });
    await instance.stop();
    expect(instance.snapshot().current).toBeNull();

    instance.applyRelay(runningSnapshot(original));
    expect(instance.snapshot().current).toBeNull();
  });

  it.each([409, 404])("converges stop status %i through its required path", async (status) => {
    const fetchCurrent = vi.fn(async () => success(null));
    const stopTimeEntry = vi.fn(async () => failure({ status }));
    const instance = coordinator(api({ fetchCurrent, stopTimeEntry }), {
      initialCurrent: entry(),
    });

    await expect(instance.stop()).resolves.toMatchObject({ outcome: "stopped", error: null });
    expect(instance.snapshot().current).toBeNull();
    expect(fetchCurrent).toHaveBeenCalledTimes(status === 404 ? 1 : 0);
  });

  it("checks an ambiguous create exactly once and accepts a matching running activity", async () => {
    const matching = entry();
    const fetchCurrent = vi.fn(async () => success(matching));
    const createRunningEntry = vi.fn(async () => failure({ mayHaveSucceeded: true, status: null }));
    const instance = coordinator(api({ createRunningEntry, fetchCurrent }));

    await expect(instance.resume()).resolves.toMatchObject({ outcome: "resumed" });
    expect(fetchCurrent).toHaveBeenCalledTimes(1);
    expect(instance.snapshot()).toMatchObject({ confidence: "confirmed", error: null });
  });

  it("trusts a different current after ambiguous create", async () => {
    const external = entry({ id: "999", description: "External" });
    const instance = coordinator(
      api({
        createRunningEntry: vi.fn(async () => failure({ mayHaveSucceeded: true })),
        fetchCurrent: vi.fn(async () => success(external)),
      }),
    );

    await expect(instance.resume()).resolves.toMatchObject({
      outcome: "failed",
      error: "request_failed",
    });
    expect(instance.snapshot()).toMatchObject({
      confidence: "confirmed",
      current: { id: "999" },
    });
  });

  it("blocks another resume after an unresolved ambiguous create until REST reconciliation", async () => {
    const fetchCurrent = vi
      .fn()
      .mockResolvedValueOnce(failure())
      .mockResolvedValueOnce(success(null));
    const createRunningEntry = vi
      .fn()
      .mockResolvedValueOnce(failure({ mayHaveSucceeded: true }))
      .mockResolvedValueOnce(success(entry()));
    const instance = coordinator(api({ createRunningEntry, fetchCurrent }));

    await expect(instance.resume()).resolves.toMatchObject({ error: "ambiguous_create" });
    await expect(instance.resume()).resolves.toMatchObject({ error: "ambiguous_create" });
    expect(createRunningEntry).toHaveBeenCalledTimes(1);
    await expect(instance.reconcile("current")).resolves.toBe(true);
    await instance.resume();
    expect(createRunningEntry).toHaveBeenCalledTimes(2);
  });

  it("records quota headers for every interactive API call", async () => {
    const record = vi.fn();
    const instance = coordinator(api(), { quotaRecord: record, initialCurrent: entry() });
    await instance.stop();
    await instance.resume();
    expect(record).toHaveBeenCalledTimes(2);
    expect(record.mock.calls.every((call) => call[0].quota === quota)).toBe(true);
  });

  it("refreshes and persists presets only when rich REST data changes the list", async () => {
    const persist = vi.fn(async () => undefined);
    const instance = coordinator(api(), { initialPresets: [], persistPresets: persist });
    await instance.reconcile("full");
    expect(persist).not.toHaveBeenCalled();

    const rich = entry({ start: "2026-08-27T11:00:00Z" });
    const filled = coordinator(
      api({
        fetchToday: vi.fn(async () => success([rich])),
        fetchCurrent: vi.fn(async () => success(null)),
      }),
      { initialPresets: [], persistPresets: persist },
    );
    await filled.reconcile("full");
    expect(persist).toHaveBeenCalledTimes(1);
    expect(filled.snapshot().presets[0]).toMatchObject({ description: "Review" });
  });

  it("surfaces preset persistence failure without rolling back timer state", async () => {
    const log = vi.fn();
    const instance = new ClientCoordinator({
      api: api(),
      timezone: "Africa/Cairo",
      quotaGate: { record: vi.fn() },
      now: () => now,
      initialState: setConnection(createState("2026-08-27"), "connected"),
      initialConfidence: "confirmed",
      initialPresets: [preset()],
      persistPresets: async () => {
        throw new Error("disk full");
      },
      log,
    });

    await expect(instance.resume()).resolves.toMatchObject({ outcome: "resumed" });
    expect(instance.snapshot()).toMatchObject({
      status: "running",
      current: { id: "101" },
      error: "request_failed",
    });
    expect(log).toHaveBeenCalledWith("preset_persist_failed", expect.any(Error));
  });
});
