import type { NormalizedEntry, RelayMessage, RunningSnapshot } from "@toggl-waybar-live/shared";

import { type DayWindow, instantBelongsToDay } from "./day-window.js";

export type ConnectionState = "connected" | "stale" | "offline";

export interface CurrentEntry {
  description: string;
  id: string;
  projectId: string | null;
  projectName: string | null;
  start: string;
  workspaceId: string;
}

export interface ClientState {
  connection: ConnectionState;
  current: CurrentEntry | null;
  currentContributesToToday: boolean;
  dayKey: string;
  entries: Map<string, NormalizedEntry>;
  lastSynchronizedAt: string | null;
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
}

export function createState(dayKey: string): ClientState {
  return {
    connection: "offline",
    current: null,
    currentContributesToToday: false,
    dayKey,
    entries: new Map(),
    lastSynchronizedAt: null,
  };
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
    projectName: known?.projectName ?? previous?.projectName ?? null,
    description: snapshot.description,
    start: snapshot.start,
  };
}

export function applyRelayMessage(
  initialState: ClientState,
  message: RelayMessage,
  window: DayWindow,
): ClientState {
  const state = rotateDay(initialState, window);
  if (message.type === "snapshot") {
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
    return { ...state, entries };
  }

  const entry = message.change.entry;
  if (instantBelongsToDay(entry.start, window)) {
    entries.set(entry.id, entry);
  } else {
    entries.delete(entry.id);
  }

  const current =
    state.current?.id === entry.id
      ? {
          id: entry.id,
          workspaceId: entry.workspaceId,
          projectId: entry.projectId,
          projectName: entry.projectName,
          description: entry.description,
          start: entry.start,
        }
      : state.current;
  return {
    ...state,
    current,
    currentContributesToToday:
      current === null ? false : instantBelongsToDay(current.start, window),
    entries,
  };
}

export function replaceReconciledEntries(
  initialState: ClientState,
  entries: readonly NormalizedEntry[],
  current: NormalizedEntry | null,
  window: DayWindow,
  synchronizedAt: string,
): ClientState {
  const state = rotateDay(initialState, window);
  const today = new Map<string, NormalizedEntry>();
  for (const entry of entries) {
    if (instantBelongsToDay(entry.start, window)) {
      today.set(entry.id, entry);
    }
  }

  return {
    ...state,
    current:
      current === null
        ? null
        : {
            id: current.id,
            workspaceId: current.workspaceId,
            projectId: current.projectId,
            projectName: current.projectName,
            description: current.description,
            start: current.start,
          },
    currentContributesToToday: current !== null && instantBelongsToDay(current.start, window),
    entries: today,
    lastSynchronizedAt: synchronizedAt,
  };
}

export function replaceReconciledCurrent(
  initialState: ClientState,
  current: NormalizedEntry | null,
  window: DayWindow,
  synchronizedAt: string,
): ClientState {
  const state = rotateDay(initialState, window);
  return {
    ...state,
    current:
      current === null
        ? null
        : {
            id: current.id,
            workspaceId: current.workspaceId,
            projectId: current.projectId,
            projectName: current.projectName,
            description: current.description,
            start: current.start,
          },
    currentContributesToToday: current !== null && instantBelongsToDay(current.start, window),
    lastSynchronizedAt: synchronizedAt,
  };
}

function completedSeconds(entries: ReadonlyMap<string, NormalizedEntry>): number {
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
  };
}
