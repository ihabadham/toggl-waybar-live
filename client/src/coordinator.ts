import type { RelayMessage } from "@toggl-waybar-live/shared";

import type {
  CommandResult,
  ControlErrorCode,
  ControlRequest,
  ControlSnapshot,
} from "./control-protocol.js";
import {
  boundedControlSnapshot,
  type ControlSnapshotBase,
  chronologicalTodayEntries,
} from "./control-snapshot.js";
import { type DayWindow, dayWindowAt } from "./day-window.js";
import {
  advanceMonth,
  applyMonthEntry,
  applyMonthRelayMessage,
  completedMonthSeconds,
  createMonthState,
  type MonthState,
} from "./month-state.js";
import { instantBelongsToMonth, type MonthWindow, monthWindowAt } from "./month-window.js";
import {
  activityFromPreset,
  mergePresets,
  type ResumeActivity,
  type ResumePreset,
  upsertPresets,
} from "./presets.js";
import type { QuotaGate } from "./quota-gate.js";
import {
  advanceDay as advanceClientDay,
  applyConfirmedCurrent,
  applyConfirmedStoppedId,
  applyRelayMessage,
  applyRichCreateResult,
  applyRichStopResult,
  type ClientState,
  completedSeconds,
  createState,
  type RendererState,
  replaceReconciledEntries,
  setConnection,
  setPending,
  toRendererState,
} from "./state.js";
import type { ApiResult, RichTogglEntry, TogglApi } from "./toggl-api.js";

const toggleSuppressionMilliseconds = 800;

type CommandRequest = Exclude<ControlRequest, { type: "watch" }>;
type Confidence = "confirmed" | "uncertain";
type ReconciliationKind = "current" | "full";
type RelayChangeMessage = Extract<RelayMessage, { type: "entry.changed" }>;
type RelaySnapshotMessage = Extract<RelayMessage, { type: "snapshot" }>;

interface RelayCursor {
  eventCreatedAt: string;
  eventId: string;
}

type CoordinatorQuotaGate = Pick<QuotaGate, "record"> &
  Partial<Pick<QuotaGate, "allowsRequest" | "recordAttempt">>;

export interface CoordinatorApi {
  createRunningEntry(activity: ResumeActivity, start: string): Promise<ApiResult<RichTogglEntry>>;
  fetchCurrent(): Promise<ApiResult<RichTogglEntry | null>>;
  fetchToday(window: DayWindow): Promise<ApiResult<RichTogglEntry[]>>;
  stopTimeEntry(workspaceId: string, entryId: string): Promise<ApiResult<RichTogglEntry>>;
}

export interface ClientCoordinatorOptions {
  api: CoordinatorApi | TogglApi;
  initialConfidence?: Confidence;
  initialMonthState?: MonthState;
  initialPresets?: readonly ResumePreset[];
  initialState?: ClientState;
  log?: (event: string, error?: unknown) => void;
  monotonicNow?: () => number;
  now?: () => Date;
  persistPresets?: (presets: readonly ResumePreset[]) => Promise<void>;
  publish?: (snapshot: ControlSnapshot, rendererState: RendererState) => void;
  quotaGate: CoordinatorQuotaGate;
  timezone: string;
}

type Subscriber = (snapshot: ControlSnapshot) => void;

function commandResult(
  outcome: CommandResult["outcome"],
  error: ControlErrorCode | null = null,
): CommandResult {
  return { version: 1, type: "result", outcome, error };
}

function apiError(result: Extract<ApiResult<unknown>, { ok: false }>): ControlErrorCode {
  return result.error;
}

function canonicalValues(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function matchesActivity(
  entry: RichTogglEntry,
  activity: ResumeActivity,
  expectedStart: string,
): boolean {
  return (
    entry.stop === null &&
    entry.start === expectedStart &&
    entry.workspaceId === activity.workspaceId &&
    entry.description === activity.description &&
    entry.projectId === activity.projectId &&
    entry.taskId === activity.taskId &&
    entry.billable === activity.billable &&
    JSON.stringify(canonicalValues(entry.tagIds)) ===
      JSON.stringify(canonicalValues(activity.tagIds)) &&
    JSON.stringify(canonicalValues(entry.tags)) === JSON.stringify(canonicalValues(activity.tags))
  );
}

function timerStateValue(state: ClientState): string {
  return JSON.stringify({
    dayKey: state.dayKey,
    current: state.current,
    currentContributesToToday: state.currentContributesToToday,
    entries: [...state.entries.entries()].sort(([left], [right]) => left.localeCompare(right)),
    stoppedEntryIds: [...state.stoppedEntryIds].sort(),
  });
}

function compareRelayCursors(left: RelayCursor, right: RelayCursor): number {
  const timeDifference = Date.parse(left.eventCreatedAt) - Date.parse(right.eventCreatedAt);
  if (timeDifference !== 0) {
    return Math.sign(timeDifference);
  }
  const leftId = BigInt(left.eventId);
  const rightId = BigInt(right.eventId);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function relayCursor(message: RelaySnapshotMessage): RelayCursor {
  return {
    eventCreatedAt: message.snapshot.eventCreatedAt,
    eventId: message.snapshot.eventId,
  };
}

function changeEndsEntry(message: RelayChangeMessage, entryId: string): boolean {
  return (
    message.change.entry.id === entryId &&
    (message.change.action === "deleted" || message.change.entry.stop !== null)
  );
}

export class ClientCoordinator {
  private ambiguousCreateUnresolved = false;
  private authoritativeIdle = false;
  private readonly api: CoordinatorApi;
  private commandActive = false;
  private confidence: Confidence;
  private error: ControlErrorCode | null = null;
  private lastToggleArrival: number | null = null;
  private monthState: MonthState;
  private mutationActive = false;
  private mutationEpoch = 0;
  private mutationTail: Promise<void> = Promise.resolve();
  private persistenceTail: Promise<void> = Promise.resolve();
  private presets: ResumePreset[];
  private pendingRelaySnapshot: RelaySnapshotMessage | null = null;
  private protectedCurrentId: string | null = null;
  private relayConflictGeneration = 0;
  private relayConflictUnresolved = false;
  private relayConfirmationActive = false;
  private relayConfirmationRequested = false;
  private relayConfirmationTail: Promise<void> = Promise.resolve();
  private relayCursor: RelayCursor | null = null;
  private state: ClientState;
  private readonly subscribers = new Set<Subscriber>();
  private timerRevision = 0;

  constructor(private readonly options: ClientCoordinatorOptions) {
    this.api = options.api;
    this.confidence = options.initialConfidence ?? "uncertain";
    this.presets = mergePresets(options.initialPresets ?? []);
    const now = this.now();
    this.state = options.initialState ?? createState(this.window(now).dayKey);
    this.monthState = options.initialMonthState ?? createMonthState(this.monthWindow(now));
  }

  snapshot(): ControlSnapshot {
    return this.snapshotAt(this.timestamp());
  }

  private snapshotAt(generatedAt: string): ControlSnapshot {
    const current = this.state.current;
    const monthWindow = this.monthWindow(generatedAt);
    const base: ControlSnapshotBase = {
      version: 1,
      type: "snapshot",
      status:
        this.state.connection === "offline" ? "offline" : current === null ? "idle" : "running",
      connection: this.state.connection,
      confidence: this.confidence,
      pending: this.state.pending,
      current:
        current === null
          ? null
          : {
              id: current.id,
              workspaceId: current.workspaceId,
              description: current.description,
              projectId: current.projectId,
              projectColor: current.projectColor,
              projectName: current.projectName,
              start: current.start,
              taskName: current.taskName,
            },
      timezone: this.options.timezone,
      completedTodaySeconds: completedSeconds(this.state.entries),
      currentContributesToToday: this.state.currentContributesToToday,
      month: {
        availability: this.monthState.availability,
        partial: this.monthState.partial,
        key: this.monthState.monthKey,
        completedSeconds: completedMonthSeconds(this.monthState),
        currentContributes:
          current !== null &&
          this.monthState.monthKey === monthWindow.monthKey &&
          instantBelongsToMonth(current.start, monthWindow),
        synchronizedAt: this.monthState.synchronizedAt,
      },
      presets: [...this.presets],
      generatedAt,
      lastSynchronizedAt: this.state.lastSynchronizedAt,
      error: this.error,
    };
    return boundedControlSnapshot(base, chronologicalTodayEntries(this.state));
  }

  rendererState(): RendererState {
    return toRendererState(this.state, this.timestamp());
  }

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  handle(request: ControlRequest): Promise<CommandResult | ControlSnapshot> {
    return request.type === "watch" ? Promise.resolve(this.snapshot()) : this.command(request);
  }

  command(request: CommandRequest): Promise<CommandResult> {
    const arrival = this.monotonicNow();
    const duplicateToggle =
      request.type === "toggle" &&
      this.lastToggleArrival !== null &&
      arrival - this.lastToggleArrival < toggleSuppressionMilliseconds;
    if (request.type === "toggle") {
      this.lastToggleArrival = arrival;
    }

    if (duplicateToggle) {
      this.commit(this.state);
      return Promise.resolve(commandResult("duplicate_suppressed"));
    }
    if (this.commandActive) {
      this.commit(this.state, { error: "command_busy" });
      return Promise.resolve(commandResult("failed", "command_busy"));
    }

    return this.startMutation(async () => {
      if (request.type === "toggle") {
        return this.toggleNow();
      }
      if (request.type === "stop") {
        return this.stopNow();
      }
      return this.resumeNow(request.presetId);
    });
  }

  toggle(): Promise<CommandResult> {
    return this.command({ version: 1, type: "toggle" });
  }

  stop(): Promise<CommandResult> {
    return this.command({ version: 1, type: "stop" });
  }

  resume(presetId: string | null = null): Promise<CommandResult> {
    return this.command({ version: 1, type: "resume", presetId });
  }

  setConnection(connection: ClientState["connection"]): void {
    this.commit(setConnection(this.state, connection), {
      ...(connection === "connected" ? {} : { confidence: "uncertain" as const }),
    });
  }

  advanceCalendar(): void {
    const now = this.now();
    this.monthState = advanceMonth(this.monthState, this.monthWindow(now));
    this.commit(advanceClientDay(this.state, this.window(now)));
  }

  advanceDay(): void {
    this.advanceCalendar();
  }

  applyRelay(message: RelayMessage): void {
    const window = this.window(this.now());
    if (message.type === "snapshot") {
      const cursor = relayCursor(message);
      const matchesProtectedCurrent =
        message.snapshot.status === "running" &&
        message.snapshot.entryId === this.protectedCurrentId;
      const matchesCurrent =
        message.snapshot.status === "running"
          ? message.snapshot.entryId === this.state.current?.id
          : this.state.current === null;
      if (this.relayCursor !== null) {
        const comparison = compareRelayCursors(cursor, this.relayCursor);
        if (comparison <= 0) {
          if (
            comparison === 0 &&
            !this.relayConflictUnresolved &&
            ((this.authoritativeIdle && message.snapshot.status === "idle") ||
              matchesProtectedCurrent ||
              (!this.authoritativeIdle && this.protectedCurrentId === null && matchesCurrent))
          ) {
            this.protectedCurrentId = null;
            this.authoritativeIdle = false;
            this.commitRelayMessage(message, window);
          }
          return;
        }
      }
      if (
        this.pendingRelaySnapshot !== null &&
        compareRelayCursors(cursor, relayCursor(this.pendingRelaySnapshot)) <= 0
      ) {
        return;
      }
      if (matchesProtectedCurrent) {
        this.recordRelayCursor(cursor);
        this.protectedCurrentId = null;
        this.authoritativeIdle = false;
        this.resolveRelayConflict();
        this.commitRelayMessage(message, window);
        return;
      }
      if (
        this.relayConflictUnresolved ||
        this.protectedCurrentId !== null ||
        (this.authoritativeIdle && message.snapshot.status === "running")
      ) {
        this.deferRelayConflict(message);
        return;
      }

      this.recordRelayCursor(cursor);
      this.authoritativeIdle = false;
      this.commitRelayMessage(message, window);
      return;
    }

    const endsProtectedCurrent =
      this.protectedCurrentId !== null && changeEndsEntry(message, this.protectedCurrentId);
    if (endsProtectedCurrent) {
      this.protectedCurrentId = null;
      this.relayConflictUnresolved = true;
      this.relayConflictGeneration += 1;
    }
    this.commitRelayMessage(message, window);
    if (endsProtectedCurrent) {
      this.requestRelayConfirmation();
    }
  }

  async reconcile(kind: ReconciliationKind): Promise<boolean> {
    if (this.commandActive || this.relayConfirmationActive) {
      return false;
    }
    const revision = this.timerRevision;
    const epoch = this.mutationEpoch;
    const relayGeneration = this.relayConflictGeneration;
    const now = this.now();
    const window = this.window(now);

    if (kind === "current") {
      const current = await this.api.fetchCurrent();
      this.recordQuota(current);
      if (this.stale(revision, epoch, relayGeneration)) {
        return false;
      }
      if (!current.ok) {
        this.commit(this.state, { error: apiError(current) });
        return false;
      }
      this.commitRestCurrent(current.data, window);
      return true;
    }

    const [today, current] = await Promise.all([
      this.api.fetchToday(window),
      this.api.fetchCurrent(),
    ]);
    this.recordQuota(today);
    this.recordQuota(current);
    if (this.stale(revision, epoch, relayGeneration)) {
      return false;
    }
    if (!today.ok) {
      this.commit(this.state, { error: apiError(today) });
      return false;
    }
    if (!current.ok) {
      this.commit(this.state, { error: apiError(current) });
      return false;
    }
    const synchronizedAt = this.timestamp();
    let next = replaceReconciledEntries(
      this.state,
      today.data,
      current.data,
      window,
      synchronizedAt,
    );
    if (next.connection === "offline") {
      next = setConnection(next, "stale");
    }
    next = this.confirmRestCurrent(next, current.data);
    this.ambiguousCreateUnresolved = false;
    this.commit(next, { confidence: "confirmed", error: null });
    await this.refreshPresets([...today.data, ...(current.data === null ? [] : [current.data])]);
    return true;
  }

  async drain(): Promise<void> {
    while (true) {
      await this.mutationTail;
      const confirmation = this.relayConfirmationTail;
      await confirmation;
      if (
        confirmation === this.relayConfirmationTail &&
        !this.commandActive &&
        !this.mutationActive &&
        !this.relayConfirmationActive
      ) {
        break;
      }
    }
    await this.persistenceTail;
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  private monotonicNow(): number {
    return (this.options.monotonicNow ?? (() => performance.now()))();
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private window(now: Date): DayWindow {
    return dayWindowAt(now, this.options.timezone);
  }

  private monthWindow(now: string | Date): MonthWindow {
    return monthWindowAt(now, this.options.timezone);
  }

  private stale(revision: number, epoch: number, relayGeneration: number): boolean {
    return (
      this.commandActive ||
      revision !== this.timerRevision ||
      epoch !== this.mutationEpoch ||
      relayGeneration !== this.relayConflictGeneration
    );
  }

  private currentId(): string | null {
    return this.state.current?.id ?? null;
  }

  private recordQuota(result: ApiResult<unknown>): void {
    this.options.quotaGate.record(result, this.now().getTime());
  }

  private deferRelayConflict(message: RelaySnapshotMessage): void {
    this.pendingRelaySnapshot = message;
    this.relayConflictUnresolved = true;
    this.relayConflictGeneration += 1;
    this.commit(this.state, { confidence: "uncertain" });
    this.requestRelayConfirmation();
  }

  private resolveRelayConflict(): void {
    if (!this.relayConflictUnresolved && this.pendingRelaySnapshot === null) {
      return;
    }
    this.pendingRelaySnapshot = null;
    this.relayConflictUnresolved = false;
    this.relayConfirmationRequested = false;
    this.relayConflictGeneration += 1;
  }

  private commitRelayMessage(message: RelayMessage, window: DayWindow): void {
    this.monthState = applyMonthRelayMessage(
      this.monthState,
      message,
      this.monthWindow(this.now()),
    );
    const next = applyRelayMessage(this.state, message, window);
    const confidence =
      this.ambiguousCreateUnresolved || this.relayConflictUnresolved ? "uncertain" : "confirmed";
    this.commit(next, { confidence });
  }

  private recordRelayCursor(cursor: RelayCursor): void {
    if (this.relayCursor === null || compareRelayCursors(cursor, this.relayCursor) > 0) {
      this.relayCursor = cursor;
    }
  }

  private confirmRestCurrent(nextState: ClientState, current: RichTogglEntry | null): ClientState {
    const previousCurrentId = this.state.current?.id ?? null;
    const pending = this.pendingRelaySnapshot;
    if (pending !== null) {
      this.recordRelayCursor(relayCursor(pending));
    }
    const currentId = current?.id ?? null;
    const alreadyOrderedByRelay =
      this.state.connection === "connected" &&
      this.confidence === "confirmed" &&
      this.protectedCurrentId === null &&
      !this.authoritativeIdle &&
      this.relayCursor !== null &&
      pending === null &&
      previousCurrentId === currentId;
    const pendingConfirmsCurrent =
      current !== null &&
      pending?.snapshot.status === "running" &&
      pending.snapshot.entryId === current.id;
    this.protectedCurrentId =
      alreadyOrderedByRelay || pendingConfirmsCurrent ? null : (current?.id ?? null);
    this.authoritativeIdle = current === null && !alreadyOrderedByRelay;
    this.resolveRelayConflict();
    return current === null && previousCurrentId !== null
      ? applyConfirmedStoppedId(nextState, previousCurrentId)
      : nextState;
  }

  private confirmLocalCurrent(nextState: ClientState, current: RichTogglEntry): void {
    const pending = this.pendingRelaySnapshot;
    const pendingConfirmsCurrent =
      pending?.snapshot.status === "running" && pending.snapshot.entryId === current.id;
    const alreadyOrderedByRelay =
      this.state.connection === "connected" &&
      this.confidence === "confirmed" &&
      pending === null &&
      !this.relayConflictUnresolved &&
      this.relayCursor !== null &&
      this.state.current?.id === current.id;
    this.authoritativeIdle = false;
    this.protectedCurrentId = pendingConfirmsCurrent || alreadyOrderedByRelay ? null : current.id;
    if (pendingConfirmsCurrent && pending !== null) {
      this.recordRelayCursor(relayCursor(pending));
      this.resolveRelayConflict();
    }
    if (nextState.current?.id !== current.id) {
      this.requestRelayConfirmation();
    }
  }

  private confirmStoppedEntry(entryId: string, nextState: ClientState): void {
    const alreadyOrderedByRelay =
      this.state.connection === "connected" &&
      this.confidence === "confirmed" &&
      nextState.current === null &&
      this.state.current === null &&
      !this.relayConflictUnresolved &&
      this.relayCursor !== null;
    if (this.protectedCurrentId === entryId) {
      this.protectedCurrentId = null;
    }
    this.authoritativeIdle = nextState.current === null && !alreadyOrderedByRelay;
    if (this.relayConflictUnresolved) {
      this.requestRelayConfirmation();
    }
  }

  private requestRelayConfirmation(): void {
    if (!this.relayConflictUnresolved) {
      return;
    }
    this.relayConfirmationRequested = true;
    if (this.commandActive || this.mutationActive || this.relayConfirmationActive) {
      return;
    }

    const requestedAt = this.now().getTime();
    if (this.options.quotaGate.allowsRequest?.(requestedAt) === false) {
      this.relayConfirmationRequested = false;
      this.commit(this.state, { confidence: "uncertain", error: "quota_exhausted" });
      return;
    }
    this.options.quotaGate.recordAttempt?.("current", requestedAt);
    this.relayConfirmationRequested = false;
    this.relayConfirmationActive = true;
    const mutationEpoch = this.mutationEpoch;
    const relayGeneration = this.relayConflictGeneration;
    const confirmation = Promise.resolve()
      .then(() => this.api.fetchCurrent())
      .then((current) => {
        this.recordQuota(current);
        if (
          mutationEpoch !== this.mutationEpoch ||
          relayGeneration !== this.relayConflictGeneration
        ) {
          this.relayConfirmationRequested = this.relayConflictUnresolved;
          return;
        }
        if (!current.ok) {
          this.relayConfirmationRequested = false;
          this.commit(this.state, { confidence: "uncertain", error: apiError(current) });
          return;
        }
        this.commitRestCurrent(current.data, this.window(this.now()));
      })
      .catch((error: unknown) => {
        this.options.log?.("relay_confirmation_failed", error);
        this.commit(this.state, { confidence: "uncertain", error: "request_failed" });
      })
      .finally(() => {
        this.relayConfirmationActive = false;
        if (this.relayConfirmationRequested) {
          this.requestRelayConfirmation();
        }
      });
    this.relayConfirmationTail = confirmation;
  }

  private commit(
    nextState: ClientState,
    updates: { confidence?: Confidence; error?: ControlErrorCode | null } = {},
  ): void {
    if (timerStateValue(this.state) !== timerStateValue(nextState)) {
      this.timerRevision += 1;
    }
    this.state = nextState;
    if (updates.confidence !== undefined) {
      this.confidence = updates.confidence;
    }
    if (updates.error !== undefined) {
      this.error = updates.error;
    }
    const generatedAt = this.timestamp();
    const snapshot = this.snapshotAt(generatedAt);
    const renderer = toRendererState(this.state, generatedAt);
    try {
      this.options.publish?.(snapshot, renderer);
    } catch (error) {
      this.options.log?.("coordinator_publish_failed", error);
    }
    for (const subscriber of this.subscribers) {
      try {
        subscriber(snapshot);
      } catch (error) {
        this.options.log?.("coordinator_subscriber_failed", error);
      }
    }
  }

  private startMutation(work: () => Promise<CommandResult>): Promise<CommandResult> {
    this.commandActive = true;
    const result = Promise.resolve()
      .then(() => this.beginMutation())
      .then(work)
      .then((command) => {
        if (this.error === "command_busy") {
          this.commit(this.state, { error: command.error });
        }
        return command;
      });
    const settled = result.finally(() => {
      this.mutationActive = false;
      this.commandActive = false;
      if (this.relayConfirmationRequested) {
        this.requestRelayConfirmation();
      }
    });
    this.mutationTail = settled.then(
      () => undefined,
      () => undefined,
    );
    return settled;
  }

  private async beginMutation(): Promise<void> {
    if (this.relayConfirmationActive) {
      await this.relayConfirmationTail;
    }
    this.mutationEpoch += 1;
    this.mutationActive = true;
  }

  private async toggleNow(): Promise<CommandResult> {
    if (!(await this.ensureTrustedCurrent())) {
      return commandResult("failed", this.error ?? "state_unconfirmed");
    }
    return this.state.current === null ? this.resumeNow(null) : this.stopNow(true);
  }

  private async ensureTrustedCurrent(): Promise<boolean> {
    if (
      this.state.connection === "connected" &&
      this.confidence === "confirmed" &&
      !this.relayConflictUnresolved
    ) {
      return true;
    }
    const revision = this.timerRevision;
    const relayGeneration = this.relayConflictGeneration;
    const current = await this.api.fetchCurrent();
    this.recordQuota(current);
    if (revision !== this.timerRevision || relayGeneration !== this.relayConflictGeneration) {
      const trusted = this.confidence === "confirmed" && !this.relayConflictUnresolved;
      if (!trusted) {
        this.commit(this.state, { error: "state_unconfirmed" });
      }
      return trusted;
    }
    if (!current.ok) {
      this.commit(this.state, {
        confidence: "uncertain",
        error: current.error === "request_failed" ? "state_unconfirmed" : apiError(current),
      });
      return false;
    }
    this.commitRestCurrent(current.data, this.window(this.now()));
    return true;
  }

  private commitRestCurrent(current: RichTogglEntry | null, window: DayWindow): void {
    let next = applyConfirmedCurrent(this.state, current, window, this.timestamp());
    if (next.connection === "offline") {
      next = setConnection(next, "stale");
    }
    next = this.confirmRestCurrent(next, current);
    this.ambiguousCreateUnresolved = false;
    this.commit(next, { confidence: "confirmed", error: null });
  }

  private async stopNow(alreadyTrusted = false): Promise<CommandResult> {
    if (!alreadyTrusted && !(await this.ensureTrustedCurrent())) {
      return commandResult("failed", this.error ?? "state_unconfirmed");
    }
    const target = this.state.current;
    if (target === null) {
      this.commit(this.state, { error: null });
      return commandResult("already_idle");
    }

    this.commit(setPending(this.state, "stopping"), { error: null });
    const stopped = await this.api.stopTimeEntry(target.workspaceId, target.id);
    this.recordQuota(stopped);
    const window = this.window(this.now());
    if (stopped.ok) {
      this.monthState = applyMonthEntry(
        this.monthState,
        stopped.data,
        this.monthWindow(this.now()),
      );
      const next = setPending(applyRichStopResult(this.state, stopped.data, window), null);
      this.confirmStoppedEntry(target.id, next);
      this.commit(next, {
        confidence: this.relayConflictUnresolved ? "uncertain" : "confirmed",
        error: null,
      });
      void this.refreshPresets([stopped.data]);
      return commandResult("stopped");
    }

    if (stopped.status === 409) {
      const next = setPending(applyConfirmedStoppedId(this.state, target.id), null);
      this.confirmStoppedEntry(target.id, next);
      this.commit(next, {
        confidence: this.relayConflictUnresolved ? "uncertain" : "confirmed",
        error: null,
      });
      return commandResult("stopped");
    }

    if (stopped.status === 404) {
      const revision = this.timerRevision;
      const relayGeneration = this.relayConflictGeneration;
      const current = await this.api.fetchCurrent();
      this.recordQuota(current);
      if (revision !== this.timerRevision || relayGeneration !== this.relayConflictGeneration) {
        return this.finishMissingStopFromCurrentState(target.id);
      }
      if (current.ok) {
        if (current.data?.id === target.id) {
          this.commitRestCurrent(current.data, window);
          this.commit(setPending(this.state, null), { error: "request_failed" });
          return commandResult("failed", "request_failed");
        }
        this.commitRestCurrent(current.data, window);
        const next = setPending(applyConfirmedStoppedId(this.state, target.id), null);
        this.commit(next, { error: null });
        return commandResult("stopped");
      }
      const error = current.error === "request_failed" ? "state_unconfirmed" : apiError(current);
      this.commit(setPending(this.state, null), { confidence: "uncertain", error });
      return commandResult("failed", error);
    }

    const error = apiError(stopped);
    this.commit(setPending(this.state, null), {
      ...(stopped.mayHaveSucceeded ? { confidence: "uncertain" as const } : {}),
      error,
    });
    return commandResult("failed", error);
  }

  private finishMissingStopFromCurrentState(entryId: string): CommandResult {
    if (this.state.current?.id === entryId) {
      this.commit(setPending(this.state, null), { error: "request_failed" });
      return commandResult("failed", "request_failed");
    }
    const next = setPending(applyConfirmedStoppedId(this.state, entryId), null);
    this.confirmStoppedEntry(entryId, next);
    this.commit(next, { error: null });
    return commandResult("stopped");
  }

  private async resumeNow(presetId: string | null): Promise<CommandResult> {
    if (this.state.current !== null) {
      this.commit(this.state, {
        ...(this.relayConflictUnresolved ? {} : { error: null }),
      });
      return commandResult("already_running");
    }
    if (this.confidence !== "confirmed" || this.relayConflictUnresolved) {
      const error = this.ambiguousCreateUnresolved ? "ambiguous_create" : "state_unconfirmed";
      this.commit(this.state, { error });
      return commandResult("failed", error);
    }
    const preset =
      presetId === null
        ? this.presets[0]
        : this.presets.find((candidate) => candidate.id === presetId);
    if (!preset) {
      const missingSelection = presetId !== null;
      this.commit(this.state, { error: missingSelection ? "preset_not_found" : null });
      return commandResult(
        missingSelection ? "failed" : "drawer_required",
        missingSelection ? "preset_not_found" : null,
      );
    }

    this.commit(setPending(this.state, "resuming"), { error: null });
    const activity = activityFromPreset(preset);
    const start = this.timestamp();
    const created = await this.api.createRunningEntry(activity, start);
    this.recordQuota(created);
    const window = this.window(this.now());

    if (created.ok) {
      const currentId = this.currentId();
      const conflictingCurrent = currentId !== null && currentId !== created.data.id;
      const next = setPending(applyRichCreateResult(this.state, created.data, window), null);
      if (next.current?.id === created.data.id) {
        this.monthState = applyMonthEntry(
          this.monthState,
          created.data,
          this.monthWindow(this.now()),
        );
        this.confirmLocalCurrent(next, created.data);
      }
      this.commit(next, {
        confidence: this.relayConflictUnresolved ? "uncertain" : "confirmed",
        error: null,
      });
      void this.refreshPresets([created.data]);
      if (conflictingCurrent) {
        await this.reconcileCurrentWithinMutation();
      }
      return commandResult("resumed");
    }

    if (!created.mayHaveSucceeded) {
      const error = apiError(created);
      this.commit(setPending(this.state, null), { error });
      return commandResult("failed", error);
    }

    const revision = this.timerRevision;
    const relayGeneration = this.relayConflictGeneration;
    const current = await this.api.fetchCurrent();
    this.recordQuota(current);
    if (revision !== this.timerRevision || relayGeneration !== this.relayConflictGeneration) {
      if (this.confidence !== "confirmed") {
        this.ambiguousCreateUnresolved = true;
      }
      this.commit(setPending(this.state, null), {
        error: this.confidence === "confirmed" ? "request_failed" : "ambiguous_create",
      });
      if (this.confidence !== "confirmed") {
        return commandResult("failed", "ambiguous_create");
      }
      return commandResult("failed", "request_failed");
    }
    if (!current.ok) {
      this.ambiguousCreateUnresolved = true;
      this.commit(setPending(this.state, null), {
        confidence: "uncertain",
        error: "ambiguous_create",
      });
      return commandResult("failed", "ambiguous_create");
    }

    const matching = current.data !== null && matchesActivity(current.data, activity, start);
    this.commitRestCurrent(current.data, window);
    this.commit(setPending(this.state, null), { error: matching ? null : "request_failed" });
    if (matching && current.data !== null) {
      void this.refreshPresets([current.data]);
      return commandResult("resumed");
    }
    return commandResult("failed", "request_failed");
  }

  private async reconcileCurrentWithinMutation(): Promise<void> {
    const revision = this.timerRevision;
    const relayGeneration = this.relayConflictGeneration;
    const current = await this.api.fetchCurrent();
    this.recordQuota(current);
    if (revision !== this.timerRevision || relayGeneration !== this.relayConflictGeneration) {
      return;
    }
    if (current.ok) {
      this.commitRestCurrent(current.data, this.window(this.now()));
    } else {
      this.commit(this.state, { confidence: "uncertain", error: apiError(current) });
    }
  }

  private async refreshPresets(entries: readonly RichTogglEntry[]): Promise<void> {
    const next = upsertPresets(
      this.presets,
      entries.map((entry) => ({ activity: entry, lastUsedAt: entry.start })),
    );
    if (JSON.stringify(next) === JSON.stringify(this.presets)) {
      return;
    }
    this.presets = next;
    this.commit(this.state);
    await this.persistPresetList(this.presets);
  }

  private persistPresetList(presets: readonly ResumePreset[]): Promise<void> {
    const saved = [...presets];
    const persistence = this.persistenceTail.then(() => this.options.persistPresets?.(saved));
    this.persistenceTail = persistence.then(
      () => undefined,
      () => undefined,
    );
    return persistence.catch((error: unknown) => {
      this.options.log?.("preset_persist_failed", error);
      if (JSON.stringify(saved) === JSON.stringify(this.presets)) {
        this.commit(this.state, { error: "request_failed" });
      }
    });
  }
}
