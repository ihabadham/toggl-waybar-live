import type { NormalizedEntry, RelayMessage, RunningSnapshot } from "@toggl-waybar-live/shared";

import { type DayWindow, instantBelongsToDay } from "./day-window.js";
import type { ProjectColor } from "./project-color.js";
import type { RichTogglEntry } from "./toggl-api.js";

export type ConnectionState = "connected" | "stale" | "offline";

export interface CurrentEntry {
  description: string;
  id: string;
  projectId: string | null;
  projectColor: ProjectColor | null;
  projectName: string | null;
  start: string;
  taskName: string | null;
  workspaceId: string;
}

export interface ClientEntry extends NormalizedEntry {
  projectColor: ProjectColor | null;
  taskName: string | null;
}

type PresentableEntry = NormalizedEntry & Partial<Pick<ClientEntry, "projectColor" | "taskName">>;

export interface ClientState {
  connection: ConnectionState;
  current: CurrentEntry | null;
  currentContributesToToday: boolean;
  dayKey: string;
  entries: Map<string, ClientEntry>;
  lastSynchronizedAt: string | null;
  pending: "stopping" | "resuming" | null;
  stoppedEntryIds: ReadonlySet<string>;
}

export interface RendererState {
  status: "running" | "idle" | "offline";
  connection: ConnectionState;
  label: string | null;
  description: string | null;
  projectName: string | null;
  entryStart: string | null;
  todayTrackedSeconds: number;
  runningContributesToToday: boolean;
  generatedAt: string;
  lastSynchronizedAt: string | null;
  pending?: "stopping" | "resuming" | null;
}

export function createState(dayKey: string): ClientState {
  return {
    connection: "offline",
    current: null,
    currentContributesToToday: false,
    dayKey,
    entries: new Map(),
    lastSynchronizedAt: null,
    pending: null,
    stoppedEntryIds: new Set(),
  };
}

export function setPending(
  state: ClientState,
  pending: "stopping" | "resuming" | null,
): ClientState {
  return state.pending === pending ? state : { ...state, pending };
}

export function setConnection(state: ClientState, connection: ConnectionState): ClientState {
  return { ...state, connection };
}

function rotateDay(state: ClientState, window: DayWindow): ClientState {
  return state.dayKey === window.dayKey
    ? state
    : {
        ...state,
        dayKey: window.dayKey,
        entries: new Map(),
        currentContributesToToday:
          state.current !== null && instantBelongsToDay(state.current.start, window),
      };
}

export function advanceDay(state: ClientState, window: DayWindow): ClientState {
  return rotateDay(state, window);
}

function currentFromSnapshot(snapshot: RunningSnapshot, state: ClientState): CurrentEntry {
  const known = state.entries.get(snapshot.entryId);
  const previous = state.current?.id === snapshot.entryId ? state.current : null;
  return {
    id: snapshot.entryId,
    workspaceId: snapshot.workspaceId,
    projectId: snapshot.projectId,
    projectColor: known?.projectColor ?? previous?.projectColor ?? null,
    projectName: known?.projectName ?? previous?.projectName ?? null,
    description: snapshot.description,
    start: snapshot.start,
    taskName: known?.taskName ?? previous?.taskName ?? null,
  };
}

export function applyRelayMessage(
  initialState: ClientState,
  message: RelayMessage,
  window: DayWindow,
): ClientState {
  const state = rotateDay(initialState, window);
  if (message.type === "snapshot") {
    if (
      message.snapshot.status === "running" &&
      state.stoppedEntryIds.has(message.snapshot.entryId)
    ) {
      return state;
    }
    return {
      ...state,
      current:
        message.snapshot.status === "running" ? currentFromSnapshot(message.snapshot, state) : null,
      currentContributesToToday:
        message.snapshot.status === "running" &&
        instantBelongsToDay(message.snapshot.start, window),
    };
  }

  const entries = new Map(state.entries);
  if (message.change.action === "deleted") {
    entries.delete(message.change.entry.id);
    const deletedCurrent = state.current?.id === message.change.entry.id;
    return {
      ...state,
      current: deletedCurrent ? null : state.current,
      currentContributesToToday: deletedCurrent ? false : state.currentContributesToToday,
      entries,
      stoppedEntryIds: new Set([...state.stoppedEntryIds, message.change.entry.id]),
    };
  }

  const entry = message.change.entry;
  const known = state.entries.get(entry.id);
  const mergedEntry: ClientEntry = {
    ...known,
    ...entry,
    projectColor: known?.projectColor ?? null,
    projectName: entry.projectName ?? known?.projectName ?? null,
    taskName: known?.taskName ?? null,
  };
  if (instantBelongsToDay(entry.start, window)) {
    entries.set(entry.id, mergedEntry);
  } else {
    entries.delete(entry.id);
  }

  const entryStopped = entry.stop !== null;
  const current =
    state.current?.id === entry.id && entryStopped
      ? null
      : state.current?.id === entry.id
        ? {
            id: entry.id,
            workspaceId: entry.workspaceId,
            projectId: entry.projectId,
            projectColor: state.current.projectColor,
            projectName: entry.projectName ?? state.current.projectName,
            description: entry.description,
            start: entry.start,
            taskName: state.current.taskName,
          }
        : state.current;
  return {
    ...state,
    current,
    currentContributesToToday:
      current === null ? false : instantBelongsToDay(current.start, window),
    entries,
    stoppedEntryIds: entryStopped
      ? new Set([...state.stoppedEntryIds, entry.id])
      : state.stoppedEntryIds,
  };
}

function clientEntry(entry: PresentableEntry): ClientEntry {
  return {
    ...entry,
    projectColor: entry.projectColor ?? null,
    taskName: entry.taskName ?? null,
  };
}

function currentFromEntry(entry: PresentableEntry): CurrentEntry {
  return {
    id: entry.id,
    workspaceId: entry.workspaceId,
    projectId: entry.projectId,
    projectColor: entry.projectColor ?? null,
    projectName: entry.projectName,
    description: entry.description,
    start: entry.start,
    taskName: entry.taskName ?? null,
  };
}

function withTodayEntry(
  state: ClientState,
  entry: PresentableEntry,
  window: DayWindow,
): Map<string, ClientEntry> {
  const entries = new Map(state.entries);
  if (instantBelongsToDay(entry.start, window)) {
    entries.set(entry.id, clientEntry(entry));
  } else {
    entries.delete(entry.id);
  }
  return entries;
}

export function applyRichCreateResult(
  initialState: ClientState,
  entry: RichTogglEntry,
  window: DayWindow,
): ClientState {
  const state = rotateDay(initialState, window);
  if (state.stoppedEntryIds.has(entry.id)) {
    return state;
  }
  if (state.current !== null && state.current.id !== entry.id) {
    return state;
  }
  return {
    ...state,
    current: currentFromEntry(entry),
    currentContributesToToday: instantBelongsToDay(entry.start, window),
    entries: withTodayEntry(state, entry, window),
    stoppedEntryIds: state.stoppedEntryIds,
  };
}

export function applyRichStopResult(
  initialState: ClientState,
  entry: RichTogglEntry,
  window: DayWindow,
): ClientState {
  const state = rotateDay(initialState, window);
  return {
    ...state,
    current: state.current?.id === entry.id ? null : state.current,
    currentContributesToToday:
      state.current?.id === entry.id ? false : state.currentContributesToToday,
    entries: withTodayEntry(state, entry, window),
    stoppedEntryIds: new Set([...state.stoppedEntryIds, entry.id]),
  };
}

export function applyConfirmedStoppedId(state: ClientState, entryId: string): ClientState {
  return {
    ...state,
    current: state.current?.id === entryId ? null : state.current,
    currentContributesToToday:
      state.current?.id === entryId ? false : state.currentContributesToToday,
    stoppedEntryIds: new Set([...state.stoppedEntryIds, entryId]),
  };
}

export function applyConfirmedCurrent(
  initialState: ClientState,
  current: RichTogglEntry | null,
  window: DayWindow,
  synchronizedAt: string,
): ClientState {
  const state = rotateDay(initialState, window);
  const stoppedEntryIds = new Set(state.stoppedEntryIds);
  if (current !== null) {
    stoppedEntryIds.delete(current.id);
  }
  return {
    ...state,
    current: current === null ? null : currentFromEntry(current),
    currentContributesToToday: current !== null && instantBelongsToDay(current.start, window),
    entries: current === null ? state.entries : withTodayEntry(state, current, window),
    lastSynchronizedAt: synchronizedAt,
    stoppedEntryIds,
  };
}

export function replaceReconciledEntries(
  initialState: ClientState,
  entries: readonly PresentableEntry[],
  current: PresentableEntry | null,
  window: DayWindow,
  synchronizedAt: string,
): ClientState {
  const state = rotateDay(initialState, window);
  const today = new Map<string, ClientEntry>();
  for (const entry of entries) {
    if (instantBelongsToDay(entry.start, window)) {
      today.set(entry.id, clientEntry(entry));
    }
  }

  return {
    ...state,
    current: current === null ? null : currentFromEntry(current),
    currentContributesToToday: current !== null && instantBelongsToDay(current.start, window),
    entries: today,
    lastSynchronizedAt: synchronizedAt,
    stoppedEntryIds:
      current === null
        ? state.stoppedEntryIds
        : new Set([...state.stoppedEntryIds].filter((id) => id !== current.id)),
  };
}

export function replaceReconciledCurrent(
  initialState: ClientState,
  current: PresentableEntry | null,
  window: DayWindow,
  synchronizedAt: string,
): ClientState {
  const state = rotateDay(initialState, window);
  return {
    ...state,
    current: current === null ? null : currentFromEntry(current),
    currentContributesToToday: current !== null && instantBelongsToDay(current.start, window),
    lastSynchronizedAt: synchronizedAt,
  };
}

export function completedSeconds(entries: ReadonlyMap<string, NormalizedEntry>): number {
  let total = 0;
  for (const entry of entries.values()) {
    if (entry.stop !== null) {
      total +=
        entry.durationSeconds ??
        Math.max(0, (Date.parse(entry.stop) - Date.parse(entry.start)) / 1_000);
    }
  }
  return total;
}

export function toRendererState(state: ClientState, generatedAt: string): RendererState {
  const current = state.current;
  const runningContributesToToday = current !== null && state.currentContributesToToday;
  const runningSeconds =
    current !== null && state.currentContributesToToday
      ? Math.max(0, (Date.parse(generatedAt) - Date.parse(current.start)) / 1_000)
      : 0;
  const usableStatus = current === null ? "idle" : "running";

  return {
    status: state.connection === "offline" ? "offline" : usableStatus,
    connection: state.connection,
    label: current?.description || current?.projectName || (current ? "Running" : null),
    description: current?.description ?? null,
    projectName: current?.projectName ?? null,
    entryStart: current?.start ?? null,
    todayTrackedSeconds: completedSeconds(state.entries) + runningSeconds,
    runningContributesToToday,
    generatedAt,
    lastSynchronizedAt: state.lastSynchronizedAt,
    pending: state.pending,
  };
}
