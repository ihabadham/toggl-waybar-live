import type { RelayMessage } from "@toggl-waybar-live/shared";
import { describe, expect, it, vi } from "vitest";

import {
  ClientCoordinator,
  type ClientCoordinatorOptions,
  type CoordinatorApi,
} from "../src/coordinator.js";
import type { ResumePreset } from "../src/presets.js";
import { createState, setConnection } from "../src/state.js";
import { type ApiResult, type RichTogglEntry, TogglApi } from "../src/toggl-api.js";
import {
  type CoordinatorRequestScheduler,
  TogglRequestScheduler,
} from "../src/toggl-request-scheduler.js";

const presetId = "11111111-1111-4111-8111-111111111111";
const now = new Date("2026-08-27T12:00:00Z");
const quota = { remaining: 50, resetsInSeconds: 600 };

function entry(overrides: Partial<RichTogglEntry> = {}): RichTogglEntry {
  return {
    id: "101",
    workspaceId: "202",
    userId: "303",
    projectId: "404",
    projectColor: "#c9806b",
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
    projectColor: "#c9806b",
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

function runningSnapshot(
  value: RichTogglEntry,
  eventCreatedAt = "2026-08-27T12:00:01Z",
  eventId = "10",
): RelayMessage {
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
      eventId,
      eventCreatedAt,
    },
  };
}

function idleSnapshot(eventCreatedAt: string, eventId = "11"): RelayMessage {
  return {
    version: 1,
    type: "snapshot",
    snapshot: {
      status: "idle",
      updatedAt: eventCreatedAt,
      eventId,
      eventCreatedAt,
    },
  };
}

function changed(value: RichTogglEntry, action: "created" | "updated" = "updated"): RelayMessage {
  return {
    version: 1,
    type: "entry.changed",
    change: { action, entry: value },
  };
}

function api(overrides: Partial<CoordinatorApi> = {}): CoordinatorApi {
  return {
    fetchToday: vi.fn(async () => success([])),
    fetchMonth: vi.fn(async () => success([])),
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

function immediateScheduler(): CoordinatorRequestScheduler {
  return {
    runControl: (operation) => operation(),
    runBackground: async (operation, stillRelevant) =>
      stillRelevant() ? { status: "completed", value: await operation() } : { status: "skipped" },
    drain: async () => undefined,
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
    quotaGate?: ClientCoordinatorOptions["quotaGate"];
    quotaRecord?: (result: ApiResult<unknown>, now: number) => void;
    requestScheduler?: CoordinatorRequestScheduler;
    now?: () => Date;
  } = {},
): ClientCoordinator {
  let initialState = createState("2026-08-27");
  if (options.connected ?? true) {
    initialState = setConnection(initialState, "connected");
  }
  const instance = new ClientCoordinator({
    api: apiValue,
    timezone: "Africa/Cairo",
    weekStart: 0,
    quotaGate: options.quotaGate ?? { record: options.quotaRecord ?? vi.fn() },
    requestScheduler: options.requestScheduler ?? immediateScheduler(),
    now: options.now ?? (() => now),
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
  it("projects timezone, Today history, and locally observed week and month totals", async () => {
    const original = entry({
      id: "700",
      description: "Implement drawer",
      start: "2026-08-27T11:30:00Z",
      taskName: "Controls",
    });
    const stopped = entry({
      ...original,
      stop: "2026-08-27T12:00:00Z",
      durationSeconds: 1_800,
    });
    const instance = coordinator(api({ stopTimeEntry: vi.fn(async () => success(stopped)) }), {
      initialCurrent: original,
    });

    await expect(instance.stop()).resolves.toMatchObject({ outcome: "stopped" });

    expect(instance.snapshot()).toMatchObject({
      timezone: "Africa/Cairo",
      completedTodaySeconds: 1_800,
      todayEntries: [
        {
          id: "700",
          description: "Implement drawer",
          projectId: "404",
          projectName: "Internal",
          projectColor: "#c9806b",
          taskName: "Controls",
          start: "2026-08-27T11:30:00Z",
          stop: "2026-08-27T12:00:00Z",
          durationSeconds: 1_800,
        },
      ],
      todayEntryCount: 1,
      todayEntriesOmitted: 0,
      month: {
        availability: "unavailable",
        partial: false,
        key: "2026-08",
        completedSeconds: 1_800,
        currentContributes: false,
        synchronizedAt: null,
      },
      week: {
        availability: "unavailable",
        partial: false,
        key: "2026-08-23",
        completedSeconds: 1_800,
        currentContributes: false,
        synchronizedAt: null,
      },
    });
  });

  it("marks disconnected relay state unconfirmed until REST or relay confirms it", () => {
    const instance = coordinator(api());
    instance.setConnection("stale");
    expect(instance.snapshot().confidence).toBe("uncertain");
    instance.applyRelay(runningSnapshot(entry()));
    expect(instance.snapshot().confidence).toBe("confirmed");
  });

  it.each([
    ["running", runningSnapshot(entry(), "2026-08-27T12:00:01Z", "20")],
    ["idle", idleSnapshot("2026-08-27T12:00:01Z", "20")],
  ])("reconfirms ordinary %s state from the equal reconnect snapshot", (status, message) => {
    const fetchCurrent = vi.fn(async () => success(null));
    const instance = coordinator(api({ fetchCurrent }));

    instance.applyRelay(message);
    instance.setConnection("stale");
    instance.setConnection("connected");
    instance.applyRelay(message);

    expect(instance.snapshot()).toMatchObject({ status, confidence: "confirmed" });
    expect(fetchCurrent).not.toHaveBeenCalled();
  });

  it("suppresses Toggle from ingress monotonic time", async () => {
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

  it("rejects a concurrent worst-case command without adding it to the drain backlog", async () => {
    const initialCurrent = deferred<ApiResult<RichTogglEntry | null>>();
    const create = deferred<ApiResult<RichTogglEntry>>();
    const createConfirmation = deferred<ApiResult<RichTogglEntry | null>>();
    const fetchCurrent = vi
      .fn()
      .mockImplementationOnce(() => initialCurrent.promise)
      .mockImplementationOnce(() => createConfirmation.promise);
    const createRunningEntry = vi.fn(() => create.promise);
    const stopTimeEntry = vi.fn();
    const times = [0, 1_000];
    const instance = coordinator(api({ fetchCurrent, createRunningEntry, stopTimeEntry }), {
      connected: false,
      confidence: "uncertain",
      monotonicNow: () => times.shift() ?? 1_000,
    });

    const first = instance.toggle();
    const second = instance.toggle();
    let drained = false;
    const draining = instance.drain().then(() => {
      drained = true;
    });

    await expect(second).resolves.toMatchObject({ outcome: "failed", error: "command_busy" });
    expect(drained).toBe(false);
    await vi.waitFor(() => expect(fetchCurrent).toHaveBeenCalledTimes(1));
    initialCurrent.resolve(success(null));
    await vi.waitFor(() => expect(createRunningEntry).toHaveBeenCalledTimes(1));
    create.resolve(failure({ mayHaveSucceeded: true, status: null }));
    await vi.waitFor(() => expect(fetchCurrent).toHaveBeenCalledTimes(2));
    createConfirmation.resolve(success(entry()));

    await expect(first).resolves.toMatchObject({ outcome: "resumed" });
    await draining;
    expect(fetchCurrent).toHaveBeenCalledTimes(2);
    expect(createRunningEntry).toHaveBeenCalledTimes(1);
    expect(stopTimeEntry).not.toHaveBeenCalled();
  });

  it("responds before preset persistence settles while drain still waits for it", async () => {
    const persisted = deferred<void>();
    const persistPresets = vi.fn(() => persisted.promise);
    const instance = coordinator(api(), { persistPresets });

    const command = instance.resume();
    await vi.waitFor(() => expect(persistPresets).toHaveBeenCalledTimes(1));
    await expect(command).resolves.toMatchObject({ outcome: "resumed", error: null });

    let drained = false;
    const draining = instance.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    persisted.resolve(undefined);
    await draining;
    expect(drained).toBe(true);
  });

  it("drains an in-flight relay conflict confirmation", async () => {
    const confirmation = deferred<ApiResult<RichTogglEntry | null>>();
    const fetchCurrent = vi
      .fn()
      .mockResolvedValueOnce(success(null))
      .mockImplementationOnce(() => confirmation.promise);
    const instance = coordinator(api({ fetchCurrent }), {
      connected: false,
      confidence: "uncertain",
    });

    await instance.reconcile("current");
    instance.applyRelay(runningSnapshot(entry({ id: "700" }), "2026-08-27T12:00:01Z", "20"));
    await vi.waitFor(() => expect(fetchCurrent).toHaveBeenCalledTimes(2));

    let drained = false;
    const draining = instance.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    confirmation.resolve(success(null));
    await draining;
    expect(drained).toBe(true);
  });

  it("drains a mutation when Toggl never settles its requests", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const apiValue = new TogglApi(
        "private-test-token",
        async () => new Promise<Response>(() => undefined),
        "https://api.track.toggl.com",
        25,
      );
      const instance = coordinator(apiValue);

      const command = instance.resume();
      const draining = instance.drain();
      await vi.advanceTimersByTimeAsync(50);

      await expect(command).resolves.toMatchObject({
        outcome: "failed",
        error: "ambiguous_create",
      });
      await expect(draining).resolves.toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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

  it("uses a newer relay timer when stale Toggle confirmation resolves late", async () => {
    const confirmation = deferred<ApiResult<RichTogglEntry | null>>();
    const fetchCurrent = vi.fn(() => confirmation.promise);
    const stopTimeEntry = vi.fn(async (_workspaceId, entryId) =>
      success(
        entry({
          id: entryId,
          stop: "2026-08-27T12:10:00Z",
          durationSeconds: 600,
        }),
      ),
    );
    const createRunningEntry = vi.fn(async () => success(entry()));
    const instance = coordinator(api({ fetchCurrent, stopTimeEntry, createRunningEntry }), {
      connected: false,
      confidence: "uncertain",
    });

    const command = instance.toggle();
    await vi.waitFor(() => expect(fetchCurrent).toHaveBeenCalledTimes(1));
    instance.applyRelay(runningSnapshot(entry({ id: "700", description: "External" })));
    confirmation.resolve(success(null));

    await expect(command).resolves.toMatchObject({ outcome: "stopped" });
    expect(stopTimeEntry).toHaveBeenCalledWith("202", "700");
    expect(createRunningEntry).not.toHaveBeenCalled();
  });

  it("returns skipped when a relay or command supersedes background timer data", async () => {
    const first = deferred<ApiResult<RichTogglEntry | null>>();
    const fetchCurrent = vi.fn(() => first.promise);
    const instance = coordinator(api({ fetchCurrent }), { initialPresets: [] });
    const reconciliation = instance.reconcile("current");
    instance.applyRelay(runningSnapshot(entry({ id: "external" })));
    first.resolve(success(null));
    await expect(reconciliation).resolves.toBe("skipped");
    expect(instance.snapshot().current?.id).toBe("external");

    const second = deferred<ApiResult<RichTogglEntry | null>>();
    fetchCurrent.mockImplementationOnce(() => second.promise);
    const nextReconciliation = instance.reconcile("current");
    const stop = instance.stop();
    second.resolve(success(null));
    await expect(nextReconciliation).resolves.toBe("skipped");
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
    await expect(instance.reconcile("current")).resolves.toBe("skipped");
    expect(fetchCurrent).not.toHaveBeenCalled();
    created.resolve(success(entry()));
    await command;
  });

  it("rejects a stale idle snapshot with an equal server timestamp after a successful create", async () => {
    const created = entry();
    const createRunningEntry = vi.fn(async () => success(created));
    const instance = coordinator(
      api({ createRunningEntry, fetchCurrent: vi.fn(async () => success(created)) }),
    );

    await expect(instance.resume()).resolves.toMatchObject({ outcome: "resumed" });
    instance.applyRelay(idleSnapshot("2026-08-27T12:00:00Z"));

    expect(instance.snapshot().current?.id).toBe("101");
    await expect(instance.resume()).resolves.toMatchObject({ outcome: "already_running" });
    expect(createRunningEntry).toHaveBeenCalledTimes(1);
  });

  it("rejects a stale running snapshot and its pair despite a later server timestamp", async () => {
    const created = entry();
    const createRunningEntry = vi.fn(async () => success(entry()));
    const stale = entry({
      id: "700",
      description: "Earlier external timer",
      start: "2026-08-27T11:00:00Z",
    });
    const instance = coordinator(
      api({ createRunningEntry, fetchCurrent: vi.fn(async () => success(created)) }),
    );

    await instance.resume();
    instance.applyRelay(runningSnapshot(stale, "2026-08-27T13:00:00Z"));
    instance.applyRelay(changed(stale, "created"));

    expect(instance.snapshot().current?.id).toBe("101");
    await expect(instance.resume()).resolves.toMatchObject({ outcome: "already_running" });
    expect(createRunningEntry).toHaveBeenCalledTimes(1);
  });

  it("confirms a running snapshot after authoritative startup idle before applying it", async () => {
    const stale = entry({ id: "700", description: "Delayed stale timer" });
    const genuine = entry({ id: "800", description: "New external timer" });
    const staleConfirmation = deferred<ApiResult<RichTogglEntry | null>>();
    const genuineConfirmation = deferred<ApiResult<RichTogglEntry | null>>();
    const fetchCurrent = vi
      .fn()
      .mockResolvedValueOnce(success(null))
      .mockImplementationOnce(() => staleConfirmation.promise)
      .mockImplementationOnce(() => genuineConfirmation.promise);
    const instance = coordinator(api({ fetchCurrent }), {
      connected: false,
      confidence: "uncertain",
    });

    await instance.reconcile("current");
    instance.setConnection("connected");
    instance.applyRelay(runningSnapshot(stale, "2026-08-27T12:00:01Z", "20"));
    await vi.waitFor(() => expect(fetchCurrent).toHaveBeenCalledTimes(2));
    expect(instance.snapshot()).toMatchObject({ current: null, confidence: "uncertain" });

    staleConfirmation.resolve(success(null));
    await vi.waitFor(() =>
      expect(instance.snapshot()).toMatchObject({ current: null, confidence: "confirmed" }),
    );
    instance.applyRelay(runningSnapshot(stale, "2026-08-27T12:00:01Z", "20"));
    await Promise.resolve();
    expect(fetchCurrent).toHaveBeenCalledTimes(2);

    instance.applyRelay(runningSnapshot(genuine, "2026-08-27T12:00:02Z", "21"));
    instance.applyRelay(changed(genuine, "created"));
    await vi.waitFor(() => expect(fetchCurrent).toHaveBeenCalledTimes(3));
    expect(instance.snapshot()).toMatchObject({ current: null, confidence: "uncertain" });

    genuineConfirmation.resolve(success(genuine));
    await vi.waitFor(() =>
      expect(instance.snapshot()).toMatchObject({
        current: { id: genuine.id },
        confidence: "confirmed",
      }),
    );
    expect(fetchCurrent).toHaveBeenCalledTimes(3);
  });

  it("releases an authoritative idle fence when the relay echoes idle", async () => {
    const original = entry({ id: "700", description: "Previous timer" });
    const external = entry({ id: "800", description: "New external timer" });
    const fetchCurrent = vi.fn(async () => success(null));
    const instance = coordinator(api({ fetchCurrent }), {
      connected: false,
      confidence: "uncertain",
    });

    instance.applyRelay(runningSnapshot(original, "2026-08-27T12:00:00Z", "19"));
    await instance.reconcile("current");
    instance.setConnection("connected");
    instance.applyRelay(idleSnapshot("2026-08-27T12:00:01Z", "20"));
    instance.applyRelay(runningSnapshot(external, "2026-08-27T12:00:02Z", "21"));
    instance.applyRelay(changed(external, "created"));

    expect(instance.snapshot()).toMatchObject({
      current: { id: external.id },
      confidence: "confirmed",
    });
    expect(fetchCurrent).toHaveBeenCalledTimes(1);
  });

  it("does not re-arm a healthy relay-ordered idle state during REST reconciliation", async () => {
    const external = entry({ id: "800", description: "New external timer" });
    const fetchCurrent = vi.fn(async () => success(null));
    const instance = coordinator(api({ fetchCurrent }));

    instance.applyRelay(idleSnapshot("2026-08-27T12:00:01Z", "20"));
    await instance.reconcile("current");
    instance.applyRelay(runningSnapshot(external, "2026-08-27T12:00:02Z", "21"));

    expect(instance.snapshot().current?.id).toBe(external.id);
    expect(fetchCurrent).toHaveBeenCalledTimes(1);
  });

  it("fences a disconnected REST match before accepting a newer relay snapshot", async () => {
    const original = entry({ id: "700", description: "Original" });
    const delayed = entry({ id: "800", description: "Delayed timer" });
    const confirmation = deferred<ApiResult<RichTogglEntry | null>>();
    const fetchCurrent = vi
      .fn()
      .mockResolvedValueOnce(success(original))
      .mockImplementationOnce(() => confirmation.promise);
    const instance = coordinator(api({ fetchCurrent }), { initialCurrent: original });

    instance.setConnection("stale");
    await instance.reconcile("current");
    instance.setConnection("connected");
    instance.applyRelay(runningSnapshot(delayed, "2026-08-27T12:00:02Z", "21"));

    await vi.waitFor(() => expect(fetchCurrent).toHaveBeenCalledTimes(2));
    expect(instance.snapshot()).toMatchObject({
      current: { id: original.id },
      confidence: "uncertain",
    });
    confirmation.resolve(success(original));
    await vi.waitFor(() =>
      expect(instance.snapshot()).toMatchObject({
        current: { id: original.id },
        confidence: "confirmed",
      }),
    );
  });

  it("releases a disconnected REST fence on the equal running relay echo", async () => {
    const original = entry({ id: "700", description: "Original" });
    const replacement = entry({ id: "800", description: "Replacement" });
    const fetchCurrent = vi.fn(async () => success(original));
    const instance = coordinator(api({ fetchCurrent }), { initialCurrent: original });

    instance.setConnection("stale");
    await instance.reconcile("current");
    instance.setConnection("connected");
    instance.applyRelay(runningSnapshot(original));
    instance.applyRelay(runningSnapshot(replacement, "2026-08-27T12:00:02Z", "21"));

    expect(instance.snapshot()).toMatchObject({
      current: { id: replacement.id },
      confidence: "confirmed",
    });
    expect(fetchCurrent).toHaveBeenCalledTimes(1);
  });

  it("coalesces an in-flight conflict check onto the newest relay candidate", async () => {
    const first = entry({ id: "700", description: "First candidate" });
    const latest = entry({ id: "800", description: "Latest candidate" });
    const firstConfirmation = deferred<ApiResult<RichTogglEntry | null>>();
    const latestConfirmation = deferred<ApiResult<RichTogglEntry | null>>();
    const fetchCurrent = vi
      .fn()
      .mockResolvedValueOnce(success(null))
      .mockImplementationOnce(() => firstConfirmation.promise)
      .mockImplementationOnce(() => latestConfirmation.promise);
    const instance = coordinator(api({ fetchCurrent }), {
      connected: false,
      confidence: "uncertain",
    });

    await instance.reconcile("current");
    instance.applyRelay(runningSnapshot(first, "2026-08-27T12:00:01Z", "20"));
    await vi.waitFor(() => expect(fetchCurrent).toHaveBeenCalledTimes(2));
    instance.applyRelay(runningSnapshot(latest, "2026-08-27T12:00:02Z", "21"));

    firstConfirmation.resolve(success(first));
    await vi.waitFor(() => expect(fetchCurrent).toHaveBeenCalledTimes(3));
    latestConfirmation.resolve(success(latest));

    await vi.waitFor(() =>
      expect(instance.snapshot()).toMatchObject({
        current: { id: latest.id },
        confidence: "confirmed",
      }),
    );
    expect(fetchCurrent).toHaveBeenCalledTimes(3);
  });

  it("does not retry a failed confirmation for the same relay cursor", async () => {
    const stale = entry({ id: "700", description: "Delayed stale timer" });
    const fetchCurrent = vi
      .fn()
      .mockResolvedValueOnce(success(null))
      .mockResolvedValueOnce(failure())
      .mockResolvedValueOnce(success(null));
    const instance = coordinator(api({ fetchCurrent }), {
      connected: false,
      confidence: "uncertain",
    });

    await instance.reconcile("current");
    instance.setConnection("connected");
    const delayed = runningSnapshot(stale, "2026-08-27T12:00:01Z", "20");
    instance.applyRelay(delayed);
    await vi.waitFor(() => expect(instance.snapshot().error).toBe("request_failed"));

    instance.applyRelay(delayed);
    instance.setConnection("stale");
    instance.setConnection("connected");
    await Promise.resolve();
    expect(fetchCurrent).toHaveBeenCalledTimes(2);

    await expect(instance.stop()).resolves.toMatchObject({ outcome: "already_idle" });
    expect(fetchCurrent).toHaveBeenCalledTimes(3);
  });

  it("does not auto-retry after a command shares a failed confirmation", async () => {
    const stale = entry({ id: "700", description: "Delayed stale timer" });
    const automatic = deferred<ApiResult<RichTogglEntry | null>>();
    const explicit = deferred<ApiResult<RichTogglEntry | null>>();
    const fetchCurrent = vi
      .fn()
      .mockResolvedValueOnce(success(null))
      .mockImplementationOnce(() => automatic.promise)
      .mockImplementationOnce(() => explicit.promise);
    const instance = coordinator(api({ fetchCurrent }), {
      connected: false,
      confidence: "uncertain",
    });

    await instance.reconcile("current");
    instance.setConnection("connected");
    instance.applyRelay(runningSnapshot(stale, "2026-08-27T12:00:01Z", "20"));
    const command = instance.stop();
    automatic.resolve(failure());
    await vi.waitFor(() => expect(fetchCurrent).toHaveBeenCalledTimes(3));
    explicit.resolve(failure());

    await expect(command).resolves.toMatchObject({ outcome: "failed", error: "state_unconfirmed" });
    await instance.drain();
    expect(fetchCurrent).toHaveBeenCalledTimes(3);
  });

  it("blocks Resume after a bare protected-current stop until confirmation", async () => {
    const original = entry({ id: "600", description: "Original" });
    const confirmation = deferred<ApiResult<RichTogglEntry | null>>();
    const fetchCurrent = vi
      .fn()
      .mockResolvedValueOnce(success(original))
      .mockImplementationOnce(() => confirmation.promise);
    const createRunningEntry = vi.fn(async () => success(entry()));
    const instance = coordinator(api({ fetchCurrent, createRunningEntry }), {
      connected: false,
      confidence: "uncertain",
    });

    await instance.reconcile("current");
    instance.setConnection("connected");
    instance.applyRelay(
      changed({ ...original, stop: "2026-08-27T12:10:00Z", durationSeconds: 600 }),
    );
    const command = instance.resume();
    expect(instance.snapshot().confidence).toBe("uncertain");
    expect(createRunningEntry).not.toHaveBeenCalled();
    confirmation.resolve(failure());

    await expect(command).resolves.toMatchObject({ outcome: "failed", error: "state_unconfirmed" });
    expect(createRunningEntry).not.toHaveBeenCalled();
  });

  it("does not spend the quota reserve on relay conflict confirmation", async () => {
    const stale = entry({ id: "700", description: "Delayed stale timer" });
    const fetchCurrent = vi.fn(async () => success(null));
    const allowsRequest = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const recordAttempt = vi.fn();
    const instance = coordinator(api({ fetchCurrent }), {
      connected: false,
      confidence: "uncertain",
      quotaGate: { allowsRequest, record: vi.fn(), recordAttempt },
    });

    await instance.reconcile("current");
    const delayed = runningSnapshot(stale, "2026-08-27T12:00:01Z", "20");
    instance.applyRelay(delayed);
    instance.applyRelay(delayed);

    expect(instance.snapshot()).toMatchObject({
      current: null,
      confidence: "uncertain",
      error: "quota_exhausted",
    });
    expect(fetchCurrent).toHaveBeenCalledTimes(1);
    expect(allowsRequest).toHaveBeenCalledTimes(2);
    expect(recordAttempt).not.toHaveBeenCalled();
  });

  it.each([
    ["standalone reconnect", false],
    ["create-before-stop", true],
  ])("retains a %s switch candidate until REST confirms it", async (_scenario, includeCreate) => {
    const original = entry({ id: "600", description: "Original" });
    const replacement = entry({ id: "700", description: "Replacement" });
    const preStopConfirmation = deferred<ApiResult<RichTogglEntry | null>>();
    const switchConfirmation = deferred<ApiResult<RichTogglEntry | null>>();
    const fetchCurrent = vi
      .fn()
      .mockResolvedValueOnce(success(original))
      .mockImplementationOnce(() => preStopConfirmation.promise)
      .mockImplementationOnce(() => switchConfirmation.promise);
    const instance = coordinator(api({ fetchCurrent }), {
      connected: false,
      confidence: "uncertain",
    });

    await instance.reconcile("current");
    instance.setConnection("connected");
    instance.applyRelay(runningSnapshot(replacement, "2026-08-27T12:10:00Z", "30"));
    await vi.waitFor(() => expect(fetchCurrent).toHaveBeenCalledTimes(2));
    if (includeCreate) {
      instance.applyRelay(changed(replacement, "created"));
    }
    instance.applyRelay(
      changed(
        entry({
          ...original,
          stop: "2026-08-27T12:10:00Z",
          durationSeconds: 600,
        }),
      ),
    );

    expect(instance.snapshot()).toMatchObject({ current: null, confidence: "uncertain" });

    preStopConfirmation.resolve(success(original));
    await vi.waitFor(() => expect(fetchCurrent).toHaveBeenCalledTimes(3));
    switchConfirmation.resolve(success(replacement));
    await vi.waitFor(() =>
      expect(instance.snapshot()).toMatchObject({
        current: { id: replacement.id },
        confidence: "confirmed",
      }),
    );
    instance.applyRelay(runningSnapshot(replacement, "2026-08-27T12:10:00Z", "30"));
    expect(fetchCurrent).toHaveBeenCalledTimes(3);
  });

  it("shares an active relay confirmation with an admitted command", async () => {
    const original = entry({ id: "600", description: "Original" });
    const replacement = entry({ id: "700", description: "Replacement" });
    const confirmation = deferred<ApiResult<RichTogglEntry | null>>();
    const fetchCurrent = vi
      .fn()
      .mockResolvedValueOnce(success(original))
      .mockImplementationOnce(() => confirmation.promise);
    const stopTimeEntry = vi.fn(async (_workspaceId, entryId) =>
      success(
        entry({
          id: entryId,
          stop: "2026-08-27T12:11:00Z",
          durationSeconds: 60,
        }),
      ),
    );
    const instance = coordinator(api({ fetchCurrent, stopTimeEntry }), {
      connected: false,
      confidence: "uncertain",
    });

    await instance.reconcile("current");
    instance.setConnection("connected");
    instance.applyRelay(runningSnapshot(replacement, "2026-08-27T12:10:00Z", "30"));
    await vi.waitFor(() => expect(fetchCurrent).toHaveBeenCalledTimes(2));

    const command = instance.toggle();
    confirmation.resolve(success(replacement));

    await expect(command).resolves.toMatchObject({ outcome: "stopped" });
    expect(fetchCurrent).toHaveBeenCalledTimes(2);
    expect(stopTimeEntry).toHaveBeenCalledWith(replacement.workspaceId, replacement.id);
  });

  it("does not hold a command behind confirmations for newer relay candidates", async () => {
    const original = entry({ id: "600", description: "Original" });
    const first = entry({ id: "700", description: "First candidate" });
    const second = entry({ id: "800", description: "Second candidate" });
    const latest = entry({ id: "900", description: "Latest candidate" });
    const joined = deferred<ApiResult<RichTogglEntry | null>>();
    const explicit = deferred<ApiResult<RichTogglEntry | null>>();
    const trailing = deferred<ApiResult<RichTogglEntry | null>>();
    const fetchCurrent = vi
      .fn()
      .mockResolvedValueOnce(success(original))
      .mockImplementationOnce(() => joined.promise)
      .mockImplementationOnce(() => explicit.promise)
      .mockImplementationOnce(() => trailing.promise);
    const stopTimeEntry = vi.fn();
    const instance = coordinator(api({ fetchCurrent, stopTimeEntry }), {
      connected: false,
      confidence: "uncertain",
    });

    await instance.reconcile("current");
    instance.setConnection("connected");
    instance.applyRelay(runningSnapshot(first, "2026-08-27T12:10:00Z", "30"));
    const command = instance.toggle();
    instance.applyRelay(runningSnapshot(second, "2026-08-27T12:10:01Z", "31"));
    joined.resolve(success(first));
    await vi.waitFor(() => expect(fetchCurrent).toHaveBeenCalledTimes(3));
    instance.applyRelay(runningSnapshot(latest, "2026-08-27T12:10:02Z", "32"));
    explicit.resolve(success(second));

    await expect(command).resolves.toMatchObject({ outcome: "failed", error: "state_unconfirmed" });
    await vi.waitFor(() => expect(fetchCurrent).toHaveBeenCalledTimes(4));
    expect(stopTimeEntry).not.toHaveBeenCalled();
    trailing.resolve(success(latest));
    await instance.drain();
    expect(instance.snapshot().current?.id).toBe(latest.id);
  });

  it("accepts a newer relay echo after a successful create", async () => {
    const created = entry();
    const instance = coordinator(api({ createRunningEntry: vi.fn(async () => success(created)) }));

    await instance.resume();
    instance.setConnection("stale");
    instance.applyRelay(runningSnapshot(created, "2026-08-27T12:00:01Z"));

    expect(instance.snapshot()).toMatchObject({
      confidence: "confirmed",
      current: { id: created.id },
    });
  });

  it("does not re-arm a local create after its relay echo already arrived", async () => {
    const created = entry();
    const external = entry({ id: "700", description: "Later external timer" });
    const creation = deferred<ApiResult<RichTogglEntry>>();
    const fetchCurrent = vi.fn(async () => success(external));
    const instance = coordinator(
      api({ createRunningEntry: vi.fn(() => creation.promise), fetchCurrent }),
    );

    instance.applyRelay(idleSnapshot("2026-08-27T11:59:59Z", "19"));
    const command = instance.resume();
    await vi.waitFor(() => expect(instance.snapshot().pending).toBe("resuming"));
    instance.applyRelay(runningSnapshot(created, "2026-08-27T12:00:01Z", "20"));
    creation.resolve(success(created));
    await command;

    instance.applyRelay(runningSnapshot(external, "2026-08-27T12:00:02Z", "21"));
    expect(instance.snapshot().current?.id).toBe(external.id);
    expect(fetchCurrent).not.toHaveBeenCalled();
  });

  it("re-arms a local create fence when its relay echo predates a disconnect", async () => {
    const created = entry();
    const external = entry({ id: "700", description: "Delayed external timer" });
    const creation = deferred<ApiResult<RichTogglEntry>>();
    const confirmation = deferred<ApiResult<RichTogglEntry | null>>();
    const fetchCurrent = vi.fn(() => confirmation.promise);
    const instance = coordinator(
      api({ createRunningEntry: vi.fn(() => creation.promise), fetchCurrent }),
    );

    const command = instance.resume();
    await vi.waitFor(() => expect(instance.snapshot().pending).toBe("resuming"));
    instance.applyRelay(runningSnapshot(created, "2026-08-27T12:00:01Z", "20"));
    instance.setConnection("stale");
    creation.resolve(success(created));
    await command;
    instance.setConnection("connected");
    instance.applyRelay(runningSnapshot(external, "2026-08-27T12:00:02Z", "21"));

    await vi.waitFor(() => expect(fetchCurrent).toHaveBeenCalledTimes(1));
    expect(instance.snapshot()).toMatchObject({
      current: { id: created.id },
      confidence: "uncertain",
    });
    confirmation.resolve(success(created));
    await instance.drain();
    expect(instance.snapshot().current?.id).toBe(created.id);
  });

  it("does not re-arm a local stop after its relay echo already arrived", async () => {
    const original = entry();
    const stopped = entry({
      stop: "2026-08-27T12:10:00Z",
      durationSeconds: 600,
    });
    const external = entry({ id: "700", description: "Later external timer" });
    const stopResult = deferred<ApiResult<RichTogglEntry>>();
    const fetchCurrent = vi.fn(async () => success(external));
    const instance = coordinator(
      api({ stopTimeEntry: vi.fn(() => stopResult.promise), fetchCurrent }),
    );

    instance.applyRelay(runningSnapshot(original, "2026-08-27T12:00:00Z", "19"));
    const command = instance.stop();
    await vi.waitFor(() => expect(instance.snapshot().pending).toBe("stopping"));
    instance.applyRelay(idleSnapshot("2026-08-27T12:00:01Z", "20"));
    instance.applyRelay(changed(stopped));
    stopResult.resolve(success(stopped));
    await command;

    instance.applyRelay(runningSnapshot(external, "2026-08-27T12:00:02Z", "21"));
    expect(instance.snapshot().current?.id).toBe(external.id);
    expect(fetchCurrent).not.toHaveBeenCalled();
  });

  it("uses the matching echo cursor to accept a later realtime switch", async () => {
    const created = entry();
    const external = entry({
      id: "700",
      description: "Later external timer",
      start: "2026-08-27T12:10:00Z",
    });
    const instance = coordinator(
      api({
        createRunningEntry: vi.fn(async () => success(created)),
        fetchCurrent: vi.fn(async () => success(created)),
      }),
    );

    await instance.resume();
    instance.applyRelay(runningSnapshot(created, "2026-08-27T12:05:00Z", "20"));
    await instance.reconcile("current");
    instance.applyRelay(runningSnapshot(external, "2026-08-27T12:05:00Z", "21"));
    instance.applyRelay(changed(external, "created"));

    expect(instance.snapshot().current?.id).toBe(external.id);
  });

  it("fences conflicting snapshots after a successful REST current check without comparing clocks", async () => {
    const current = entry({ id: "800", description: "REST current" });
    const instance = coordinator(api({ fetchCurrent: vi.fn(async () => success(current)) }), {
      connected: false,
      confidence: "uncertain",
    });

    await expect(instance.reconcile("current")).resolves.toBe("completed");
    instance.applyRelay(idleSnapshot("2099-08-27T11:59:59Z"));

    expect(instance.snapshot().current?.id).toBe(current.id);
  });

  it("tombstones the prior current when REST confirms idle", async () => {
    const current = entry({ id: "800", description: "REST current" });
    const fetchCurrent = vi
      .fn()
      .mockResolvedValueOnce(success(current))
      .mockResolvedValueOnce(success(null));
    const instance = coordinator(api({ fetchCurrent }), {
      connected: false,
      confidence: "uncertain",
    });

    await instance.reconcile("current");
    await instance.reconcile("current");
    instance.applyRelay(runningSnapshot(current, "2099-08-27T11:59:59Z", "999"));

    expect(instance.snapshot().current).toBeNull();
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
    instance.applyRelay(runningSnapshot(external, "2026-08-27T12:00:02Z", "11"));
    instance.applyRelay(changed(external, "created"));
    stopped.resolve(success(entry({ ...original, stop: now.toISOString(), durationSeconds: 1 })));

    await expect(command).resolves.toMatchObject({ outcome: "stopped" });
    expect(instance.snapshot().current?.id).toBe("202");
  });

  it("discards conflict reconciliation when a newer relay timer arrives", async () => {
    const created = deferred<ApiResult<RichTogglEntry>>();
    const reconciliation = deferred<ApiResult<RichTogglEntry | null>>();
    const external = entry({ id: "202", description: "External" });
    const newer = entry({ id: "203", description: "Newer external" });
    const fetchCurrent = vi.fn(() => reconciliation.promise);
    const instance = coordinator(
      api({ createRunningEntry: vi.fn(() => created.promise), fetchCurrent }),
    );

    const command = instance.resume();
    await vi.waitFor(() => expect(instance.snapshot().pending).toBe("resuming"));
    instance.applyRelay(runningSnapshot(external));
    created.resolve(success(entry({ id: "303" })));
    await vi.waitFor(() => expect(fetchCurrent).toHaveBeenCalledTimes(1));
    instance.applyRelay(runningSnapshot(newer, "2026-08-27T12:00:02Z", "11"));
    instance.applyRelay(changed(newer, "created"));
    reconciliation.resolve(success(external));

    await expect(command).resolves.toMatchObject({ outcome: "resumed" });
    expect(instance.snapshot().current?.id).toBe("203");
    expect(fetchCurrent).toHaveBeenCalledTimes(1);
  });

  it("lets a stop webhook beat a delayed successful create response", async () => {
    const created = deferred<ApiResult<RichTogglEntry>>();
    const running = entry({ id: "303" });
    const instance = coordinator(api({ createRunningEntry: vi.fn(() => created.promise) }));

    const command = instance.resume();
    await vi.waitFor(() => expect(instance.snapshot().pending).toBe("resuming"));
    instance.applyRelay(
      changed({
        ...running,
        stop: "2026-08-27T12:00:01Z",
        durationSeconds: 1,
      }),
    );
    created.resolve(success(running));

    await expect(command).resolves.toMatchObject({ outcome: "resumed" });
    expect(instance.snapshot()).toMatchObject({
      current: null,
      month: { completedSeconds: 1 },
    });
    instance.applyRelay(changed(running));
    expect(instance.snapshot()).toMatchObject({
      current: null,
      month: { completedSeconds: 1 },
    });
    instance.applyRelay(runningSnapshot(running));
    expect(instance.snapshot()).toMatchObject({
      current: null,
      month: { completedSeconds: 1 },
    });
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

  it("tombstones Stop 404 when current reconciliation finds a different timer", async () => {
    const current = deferred<ApiResult<RichTogglEntry | null>>();
    const original = entry({ id: "101" });
    const external = entry({ id: "202", description: "External" });
    const instance = coordinator(
      api({
        stopTimeEntry: vi.fn(async () => failure({ status: 404 })),
        fetchCurrent: vi.fn(() => current.promise),
      }),
      { initialCurrent: original },
    );

    const command = instance.stop();
    await vi.waitFor(() => expect(instance.snapshot().pending).toBe("stopping"));
    current.resolve(success(external));

    await expect(command).resolves.toMatchObject({ outcome: "stopped", error: null });
    expect(instance.snapshot().current?.id).toBe("202");
    instance.applyRelay(runningSnapshot(original));
    expect(instance.snapshot().current?.id).toBe("202");
  });

  it("fails Stop 404 when current reconciliation still finds the target", async () => {
    const original = entry({ id: "101" });
    const instance = coordinator(
      api({
        stopTimeEntry: vi.fn(async () => failure({ status: 404 })),
        fetchCurrent: vi.fn(async () => success(original)),
      }),
      { initialCurrent: original },
    );

    await expect(instance.stop()).resolves.toMatchObject({
      outcome: "failed",
      error: "request_failed",
    });
    expect(instance.snapshot().current?.id).toBe("101");
  });

  it("discards a late Stop 404 current result after a newer relay timer", async () => {
    const current = deferred<ApiResult<RichTogglEntry | null>>();
    const original = entry({ id: "101" });
    const external = entry({ id: "202", description: "External" });
    const instance = coordinator(
      api({
        stopTimeEntry: vi.fn(async () => failure({ status: 404 })),
        fetchCurrent: vi.fn(() => current.promise),
      }),
      { initialCurrent: original },
    );

    const command = instance.stop();
    await vi.waitFor(() => expect(instance.snapshot().pending).toBe("stopping"));
    instance.applyRelay(runningSnapshot(external, "2026-08-27T12:00:02Z", "11"));
    instance.applyRelay(changed(external, "created"));
    current.resolve(success(null));

    await expect(command).resolves.toMatchObject({ outcome: "stopped", error: null });
    expect(instance.snapshot().current?.id).toBe("202");
    instance.applyRelay(runningSnapshot(original));
    expect(instance.snapshot().current?.id).toBe("202");
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

  it("discards ambiguous-create confirmation after a newer relay timer", async () => {
    const current = deferred<ApiResult<RichTogglEntry | null>>();
    const external = entry({ id: "999", description: "External" });
    const instance = coordinator(
      api({
        createRunningEntry: vi.fn(async () => failure({ mayHaveSucceeded: true })),
        fetchCurrent: vi.fn(() => current.promise),
      }),
    );

    const command = instance.resume();
    await vi.waitFor(() => expect(instance.snapshot().pending).toBe("resuming"));
    instance.applyRelay(runningSnapshot(external));
    current.resolve(success(entry()));

    await expect(command).resolves.toMatchObject({
      outcome: "failed",
      error: "request_failed",
    });
    expect(instance.snapshot().current?.id).toBe("999");
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
    await expect(instance.reconcile("current")).resolves.toBe("completed");
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

  it("reconciles full state in Today, current, then month order without overlap", async () => {
    const order: string[] = [];
    let active = 0;
    let maximumActive = 0;
    async function requested<T>(name: string, result: T): Promise<T> {
      order.push(name);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return result;
    }
    const instance = coordinator(
      api({
        fetchToday: vi.fn(() => requested("today", success([]))),
        fetchCurrent: vi.fn(() => requested("current", success(null))),
        fetchMonth: vi.fn(() => requested("month", success([]))),
      }),
    );

    await expect(instance.reconcile("full")).resolves.toBe("completed");

    expect(order).toEqual(["today", "current", "month"]);
    expect(maximumActive).toBe(1);
  });

  it("refreshes the month at startup and again only after one hour", async () => {
    let clock = new Date("2026-08-27T12:00:00Z");
    const fetchMonth = vi.fn(async () => success([]));
    const instance = coordinator(api({ fetchMonth }), { now: () => clock });

    await expect(instance.reconcile("full")).resolves.toBe("completed");
    clock = new Date("2026-08-27T12:59:59.999Z");
    await expect(instance.reconcile("full")).resolves.toBe("completed");
    expect(fetchMonth).toHaveBeenCalledTimes(1);

    clock = new Date("2026-08-27T13:00:00Z");
    await expect(instance.reconcile("full")).resolves.toBe("completed");
    expect(fetchMonth).toHaveBeenCalledTimes(2);
  });

  it("does not let reconnect refresh requests bypass the hourly month guard", async () => {
    let clock = new Date("2026-08-27T12:00:00Z");
    const fetchMonth = vi.fn(async () => success([]));
    const instance = coordinator(api({ fetchMonth }), { now: () => clock });

    await instance.reconcile("full");
    instance.setConnection("stale");
    instance.setConnection("connected");
    clock = new Date("2026-08-27T12:30:00Z");
    await instance.reconcile("full");
    expect(fetchMonth).toHaveBeenCalledTimes(1);

    clock = new Date("2026-08-27T13:00:00Z");
    await instance.reconcile("full");
    expect(fetchMonth).toHaveBeenCalledTimes(2);
  });

  it("does not let month rollover bypass the hourly refresh guard", async () => {
    let clock = new Date("2026-08-31T20:30:00Z");
    const fetchMonth = vi.fn(async (_window: Parameters<CoordinatorApi["fetchMonth"]>[0]) =>
      success([]),
    );
    const instance = coordinator(api({ fetchMonth }), { now: () => clock });

    await instance.reconcile("full");
    clock = new Date("2026-08-31T21:01:00Z");
    instance.advanceCalendar();
    await instance.reconcile("full");
    expect(fetchMonth).toHaveBeenCalledTimes(1);

    clock = new Date("2026-08-31T21:30:00Z");
    await instance.reconcile("full");
    expect(fetchMonth).toHaveBeenCalledTimes(2);
    expect(fetchMonth.mock.calls.map(([window]) => window.monthKey)).toEqual([
      "2026-08",
      "2026-09",
    ]);
  });

  it("skips the optional month read when the quota reserve is reached after core reads", async () => {
    const fetchCurrent = vi.fn(async () => success(null));
    const fetchMonth = vi.fn(async () => success([]));
    const allowsRequest = vi.fn(() => fetchCurrent.mock.calls.length === 0);
    const instance = coordinator(api({ fetchCurrent, fetchMonth }), {
      quotaGate: { allowsRequest, record: vi.fn() },
    });

    await expect(instance.reconcile("full")).resolves.toBe("completed");

    expect(fetchCurrent).toHaveBeenCalledTimes(1);
    expect(fetchMonth).not.toHaveBeenCalled();
    expect(instance.snapshot()).toMatchObject({ error: null });
  });

  it("keeps a successful core refresh and prior month data when the optional month read fails", async () => {
    let clock = new Date("2026-08-27T12:00:00Z");
    const prior = entry({
      id: "month-prior",
      start: "2026-08-10T08:00:00Z",
      stop: "2026-08-10T08:20:00Z",
      durationSeconds: 1_200,
    });
    const recent = entry({
      id: "today-recent",
      start: "2026-08-27T11:55:00Z",
      stop: "2026-08-27T12:00:00Z",
      durationSeconds: 300,
    });
    let refresh = 0;
    const fetchToday = vi.fn(async () => success(refresh === 0 ? [] : [recent]));
    const fetchMonth = vi.fn(async () => (refresh++ === 0 ? success([prior]) : failure()));
    const instance = coordinator(api({ fetchToday, fetchMonth }), { now: () => clock });

    await expect(instance.reconcile("full")).resolves.toBe("completed");
    expect(instance.snapshot().month).toMatchObject({
      availability: "ready",
      completedSeconds: 1_200,
    });

    clock = new Date("2026-08-27T13:00:00Z");
    await expect(instance.reconcile("full")).resolves.toBe("completed");
    expect(instance.snapshot()).toMatchObject({
      completedTodaySeconds: 300,
      error: null,
      month: {
        availability: "stale",
        completedSeconds: 1_500,
        partial: false,
      },
    });
  });

  it("marks a 1,000-row month response partial", async () => {
    const monthEntries = Array.from({ length: 1_000 }, (_, index) =>
      entry({
        id: `month-${index}`,
        start: "2026-08-10T08:00:00Z",
        stop: "2026-08-10T08:01:00Z",
        durationSeconds: 60,
      }),
    );
    const instance = coordinator(api({ fetchMonth: vi.fn(async () => success(monthEntries)) }));

    await expect(instance.reconcile("full")).resolves.toBe("completed");
    expect(instance.snapshot().month).toMatchObject({
      availability: "ready",
      completedSeconds: 60_000,
      partial: true,
    });
  });

  it("does not let a stale month result overwrite a webhook mutation", async () => {
    const monthResult = deferred<ApiResult<RichTogglEntry[]>>();
    const webhookEntry = entry({
      id: "webhook-entry",
      start: "2026-08-27T11:53:00Z",
      stop: "2026-08-27T12:00:00Z",
      durationSeconds: 420,
    });
    const staleEntry = entry({
      id: "stale-month-entry",
      start: "2026-08-10T08:00:00Z",
      stop: "2026-08-10T10:00:00Z",
      durationSeconds: 7_200,
    });
    const fetchMonth = vi.fn(() => monthResult.promise);
    const instance = coordinator(api({ fetchMonth }));

    const reconciliation = instance.reconcile("full");
    await vi.waitFor(() => expect(fetchMonth).toHaveBeenCalledTimes(1));
    instance.applyRelay(changed(webhookEntry));
    monthResult.resolve(success([staleEntry]));

    await expect(reconciliation).resolves.toBe("completed");
    expect(instance.snapshot()).toMatchObject({
      completedTodaySeconds: 420,
      month: { completedSeconds: 420 },
    });
  });

  it("discards a month result after a relay snapshot changes the current timer", async () => {
    const monthResult = deferred<ApiResult<RichTogglEntry[]>>();
    const replacement = entry({ id: "replacement", description: "Replacement timer" });
    const staleEntry = entry({
      id: "stale-month-entry",
      start: "2026-08-10T08:00:00Z",
      stop: "2026-08-10T10:00:00Z",
      durationSeconds: 7_200,
    });
    const fetchMonth = vi.fn(() => monthResult.promise);
    const instance = coordinator(api({ fetchMonth }));
    instance.applyRelay(idleSnapshot("2026-08-27T11:59:59Z", "9"));

    const reconciliation = instance.reconcile("full");
    await vi.waitFor(() => expect(fetchMonth).toHaveBeenCalledTimes(1));
    instance.applyRelay(runningSnapshot(replacement));
    monthResult.resolve(success([staleEntry]));

    await expect(reconciliation).resolves.toBe("completed");
    expect(instance.snapshot()).toMatchObject({
      current: { id: replacement.id },
      month: { availability: "unavailable", completedSeconds: 0 },
    });
  });

  it("does not let a stale month result overwrite an accepted local stop", async () => {
    const original = entry({ id: "local-entry", start: "2026-08-27T11:50:00Z" });
    const stopped = entry({
      ...original,
      stop: "2026-08-27T12:00:00Z",
      durationSeconds: 600,
    });
    const staleEntry = entry({
      id: "stale-month-entry",
      start: "2026-08-10T08:00:00Z",
      stop: "2026-08-10T10:00:00Z",
      durationSeconds: 7_200,
    });
    const monthResult = deferred<ApiResult<RichTogglEntry[]>>();
    const fetchMonth = vi.fn(() => monthResult.promise);
    const instance = coordinator(
      api({
        fetchCurrent: vi.fn(async () => success(original)),
        fetchMonth,
        stopTimeEntry: vi.fn(async () => success(stopped)),
      }),
      {
        initialCurrent: original,
        requestScheduler: new TogglRequestScheduler({
          minimumStartIntervalMilliseconds: 0,
        }),
      },
    );

    const reconciliation = instance.reconcile("full");
    await vi.waitFor(() => expect(fetchMonth).toHaveBeenCalledTimes(1));
    const stop = instance.stop();
    expect(instance.snapshot().pending).toBeNull();
    monthResult.resolve(success([staleEntry]));

    await expect(reconciliation).resolves.toBe("completed");
    await expect(stop).resolves.toMatchObject({ outcome: "stopped" });
    expect(instance.snapshot()).toMatchObject({
      completedTodaySeconds: 600,
      month: { completedSeconds: 600 },
    });
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

    const beforeToday = entry({
      id: "808",
      description: "Overnight",
      start: "2026-08-26T20:00:00Z",
    });
    const overnight = coordinator(
      api({
        fetchToday: vi.fn(async () => success([])),
        fetchCurrent: vi.fn(async () => success(beforeToday)),
      }),
      { initialPresets: [] },
    );
    await overnight.reconcile("full");
    expect(overnight.snapshot().presets[0]).toMatchObject({
      description: "Overnight",
      lastUsedAt: "2026-08-26T20:00:00Z",
    });
  });

  it("preserves an existing preset UUID when an over-cap unordered batch matches it last", async () => {
    const existing = preset({ lastUsedAt: "2026-08-27T08:00:00Z" });
    const newEntries = [4, 1, 8, 3, 6, 2, 7, 5].map((hour) =>
      entry({
        id: `90${hour}`,
        description: `New activity ${hour}`,
        start: `2026-08-27T${String(8 + hour).padStart(2, "0")}:00:00Z`,
      }),
    );
    const matchingEntry = entry({ start: "2026-08-27T17:00:00Z" });
    const instance = coordinator(
      api({
        fetchToday: vi.fn(async () => success([...newEntries, matchingEntry])),
        fetchCurrent: vi.fn(async () => success(null)),
      }),
      { initialPresets: [existing] },
    );

    await instance.reconcile("full");

    const refreshed = instance.snapshot().presets;
    expect(refreshed).toHaveLength(8);
    expect(refreshed.find(({ description }) => description === "Review")?.id).toBe(existing.id);
  });

  it("surfaces preset persistence failure without rolling back timer state", async () => {
    const log = vi.fn();
    const instance = new ClientCoordinator({
      api: api(),
      timezone: "Africa/Cairo",
      weekStart: 0,
      quotaGate: { record: vi.fn() },
      requestScheduler: immediateScheduler(),
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
