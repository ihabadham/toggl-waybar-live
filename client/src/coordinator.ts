import type { RelayMessage } from "@toggl-waybar-live/shared";

import type {
  CommandResult,
  ControlErrorCode,
  ControlRequest,
  ControlSnapshot,
} from "./control-protocol.js";
import { type DayWindow, dayWindowAt } from "./day-window.js";
import {
  activityFromPreset,
  mergePresets,
  type ResumeActivity,
  type ResumePreset,
  upsertPreset,
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

export interface CoordinatorApi {
  createRunningEntry(activity: ResumeActivity, start: string): Promise<ApiResult<RichTogglEntry>>;
  fetchCurrent(): Promise<ApiResult<RichTogglEntry | null>>;
  fetchToday(window: DayWindow): Promise<ApiResult<RichTogglEntry[]>>;
  stopTimeEntry(workspaceId: string, entryId: string): Promise<ApiResult<RichTogglEntry>>;
}

export interface ClientCoordinatorOptions {
  api: CoordinatorApi | TogglApi;
  initialConfidence?: Confidence;
  initialPresets?: readonly ResumePreset[];
  initialState?: ClientState;
  log?: (event: string, error?: unknown) => void;
  monotonicNow?: () => number;
  now?: () => Date;
  persistPresets?: (presets: readonly ResumePreset[]) => Promise<void>;
  publish?: (snapshot: ControlSnapshot, rendererState: RendererState) => void;
  quotaGate: Pick<QuotaGate, "record">;
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

export class ClientCoordinator {
  private ambiguousCreateUnresolved = false;
  private readonly api: CoordinatorApi;
  private confidence: Confidence;
  private error: ControlErrorCode | null = null;
  private lastToggleArrival: number | null = null;
  private mutationCount = 0;
  private mutationEpoch = 0;
  private mutationTail: Promise<void> = Promise.resolve();
  private persistenceTail: Promise<void> = Promise.resolve();
  private presets: ResumePreset[];
  private state: ClientState;
  private readonly subscribers = new Set<Subscriber>();
  private timerRevision = 0;

  constructor(private readonly options: ClientCoordinatorOptions) {
    this.api = options.api;
    this.confidence = options.initialConfidence ?? "uncertain";
    this.presets = mergePresets(options.initialPresets ?? []);
    const now = this.now();
    this.state = options.initialState ?? createState(this.window(now).dayKey);
  }

  snapshot(): ControlSnapshot {
    return this.snapshotAt(this.timestamp());
  }

  private snapshotAt(generatedAt: string): ControlSnapshot {
    const current = this.state.current;
    return {
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
              projectName: current.projectName,
              start: current.start,
            },
      completedTodaySeconds: completedSeconds(this.state.entries),
      currentContributesToToday: this.state.currentContributesToToday,
      presets: [...this.presets],
      generatedAt,
      lastSynchronizedAt: this.state.lastSynchronizedAt,
      error: this.error,
    };
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

    return this.enqueueMutation(async () => {
      if (duplicateToggle) {
        this.commit(this.state);
        return commandResult("duplicate_suppressed");
      }
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

  advanceDay(): void {
    this.commit(advanceClientDay(this.state, this.window(this.now())));
  }

  applyRelay(message: RelayMessage): void {
    const next = applyRelayMessage(this.state, message, this.window(this.now()));
    const confidence = this.ambiguousCreateUnresolved ? this.confidence : "confirmed";
    this.commit(next, { confidence });
  }

  async reconcile(kind: ReconciliationKind): Promise<boolean> {
    if (this.mutationCount > 0) {
      return false;
    }
    const revision = this.timerRevision;
    const epoch = this.mutationEpoch;
    const now = this.now();
    const window = this.window(now);

    if (kind === "current") {
      const current = await this.api.fetchCurrent();
      this.recordQuota(current);
      if (this.stale(revision, epoch)) {
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
    if (this.stale(revision, epoch)) {
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
    this.ambiguousCreateUnresolved = false;
    this.commit(next, { confidence: "confirmed", error: null });
    await this.refreshPresets([...today.data, ...(current.data === null ? [] : [current.data])]);
    return true;
  }

  async drain(): Promise<void> {
    await this.mutationTail;
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

  private stale(revision: number, epoch: number): boolean {
    return revision !== this.timerRevision || epoch !== this.mutationEpoch;
  }

  private currentId(): string | null {
    return this.state.current?.id ?? null;
  }

  private recordQuota(result: ApiResult<unknown>): void {
    this.options.quotaGate.record(result, this.now().getTime());
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

  private enqueueMutation(work: () => Promise<CommandResult>): Promise<CommandResult> {
    this.mutationEpoch += 1;
    this.mutationCount += 1;
    const result = this.mutationTail.then(work, work);
    const settled = result.finally(() => {
      this.mutationCount -= 1;
    });
    this.mutationTail = settled.then(
      () => undefined,
      () => undefined,
    );
    return settled;
  }

  private async toggleNow(): Promise<CommandResult> {
    if (!(await this.ensureTrustedCurrent())) {
      return commandResult("failed", this.error ?? "state_unconfirmed");
    }
    return this.state.current === null ? this.resumeNow(null) : this.stopNow(true);
  }

  private async ensureTrustedCurrent(): Promise<boolean> {
    if (this.state.connection === "connected" && this.confidence === "confirmed") {
      return true;
    }
    const revision = this.timerRevision;
    const current = await this.api.fetchCurrent();
    this.recordQuota(current);
    if (revision !== this.timerRevision) {
      if (this.confidence === "confirmed") {
        return true;
      }
      this.commit(this.state, { error: "state_unconfirmed" });
      return false;
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
      const next = setPending(applyRichStopResult(this.state, stopped.data, window), null);
      this.commit(next, { confidence: "confirmed", error: null });
      await this.refreshPresets([stopped.data]);
      return commandResult("stopped");
    }

    if (stopped.status === 409) {
      const next = setPending(applyConfirmedStoppedId(this.state, target.id), null);
      this.commit(next, { confidence: "confirmed", error: null });
      return commandResult("stopped");
    }

    if (stopped.status === 404) {
      const revision = this.timerRevision;
      const current = await this.api.fetchCurrent();
      this.recordQuota(current);
      if (revision !== this.timerRevision) {
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
    this.commit(next, { error: null });
    return commandResult("stopped");
  }

  private async resumeNow(presetId: string | null): Promise<CommandResult> {
    if (this.confidence !== "confirmed") {
      const error = this.ambiguousCreateUnresolved ? "ambiguous_create" : "state_unconfirmed";
      this.commit(this.state, { error });
      return commandResult("failed", error);
    }
    if (this.state.current !== null) {
      this.commit(this.state, { error: null });
      return commandResult("already_running");
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
      this.commit(next, { confidence: "confirmed", error: null });
      await this.refreshPresets([created.data]);
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
    const current = await this.api.fetchCurrent();
    this.recordQuota(current);
    if (revision !== this.timerRevision) {
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
      await this.refreshPresets([current.data]);
      return commandResult("resumed");
    }
    return commandResult("failed", "request_failed");
  }

  private async reconcileCurrentWithinMutation(): Promise<void> {
    const revision = this.timerRevision;
    const current = await this.api.fetchCurrent();
    this.recordQuota(current);
    if (revision !== this.timerRevision) {
      return;
    }
    if (current.ok) {
      this.commitRestCurrent(current.data, this.window(this.now()));
    } else {
      this.commit(this.state, { confidence: "uncertain", error: apiError(current) });
    }
  }

  private async refreshPresets(entries: readonly RichTogglEntry[]): Promise<void> {
    let next = this.presets;
    for (const entry of entries) {
      next = upsertPreset(next, entry, entry.start);
    }
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
