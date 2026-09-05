import type { NormalizedEntry, RelayMessage } from "@toggl-waybar-live/shared";

import {
  instantBelongsToMonth,
  instantBelongsToPeriod,
  instantBelongsToWeek,
  type PeriodWindow,
} from "./period-window.js";

export interface MonthState {
  availability: "ready" | "stale" | "unavailable";
  entries: Map<string, NormalizedEntry>;
  monthKey: string;
  partial: boolean;
  synchronizedAt: string | null;
}

export function createMonthState(window: PeriodWindow): MonthState {
  return {
    availability: "unavailable",
    entries: new Map(),
    monthKey: window.monthKey,
    partial: false,
    synchronizedAt: null,
  };
}

export function advanceMonth(state: MonthState, window: PeriodWindow): MonthState {
  if (state.monthKey === window.monthKey) {
    return state;
  }
  return {
    availability: state.synchronizedAt === null ? "unavailable" : "stale",
    entries: new Map(
      [...state.entries].filter(([, entry]) => instantBelongsToPeriod(entry.start, window)),
    ),
    monthKey: window.monthKey,
    partial: state.partial,
    synchronizedAt: state.synchronizedAt,
  };
}

export function applyMonthEntry(
  initialState: MonthState,
  entry: NormalizedEntry,
  window: PeriodWindow,
): MonthState {
  const state = advanceMonth(initialState, window);
  const entries = new Map(state.entries);
  const existing = entries.get(entry.id);
  if (entry.stop === null && existing !== undefined && existing.stop !== null) {
    return state;
  }
  if (instantBelongsToPeriod(entry.start, window)) {
    entries.set(entry.id, entry);
  } else {
    entries.delete(entry.id);
  }
  return { ...state, entries };
}

export function applyMonthRelayMessage(
  initialState: MonthState,
  message: RelayMessage,
  window: PeriodWindow,
): MonthState {
  const state = advanceMonth(initialState, window);
  if (message.type === "snapshot") {
    return state;
  }
  if (message.change.action !== "deleted") {
    return applyMonthEntry(state, message.change.entry, window);
  }

  const entries = new Map(state.entries);
  entries.delete(message.change.entry.id);
  return { ...state, entries };
}

export function replaceReconciledMonthEntries(
  initialState: MonthState,
  entries: readonly NormalizedEntry[],
  window: PeriodWindow,
  synchronizedAt: string,
  partial: boolean,
): MonthState {
  const monthEntries = new Map<string, NormalizedEntry>();
  for (const entry of entries) {
    if (instantBelongsToPeriod(entry.start, window)) {
      monthEntries.set(entry.id, entry);
    }
  }
  return {
    ...advanceMonth(initialState, window),
    availability: "ready",
    entries: monthEntries,
    partial,
    synchronizedAt,
  };
}

export function markMonthRefreshFailed(initialState: MonthState, window: PeriodWindow): MonthState {
  const state = advanceMonth(initialState, window);
  return {
    ...state,
    availability: state.synchronizedAt === null ? "unavailable" : "stale",
  };
}

function completedSecondsWhere(state: MonthState, includes: (instant: string) => boolean): number {
  let total = 0;
  for (const entry of state.entries.values()) {
    if (entry.stop !== null && includes(entry.start)) {
      total +=
        entry.durationSeconds ??
        Math.max(0, (Date.parse(entry.stop) - Date.parse(entry.start)) / 1_000);
    }
  }
  return total;
}

export function completedMonthSeconds(state: MonthState, window: PeriodWindow): number {
  return completedSecondsWhere(state, (instant) => instantBelongsToMonth(instant, window));
}

export function completedWeekSeconds(state: MonthState, window: PeriodWindow): number {
  return completedSecondsWhere(state, (instant) => instantBelongsToWeek(instant, window));
}
