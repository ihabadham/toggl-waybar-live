import {
  type ControlSnapshot,
  type ControlTodayEntry,
  controlFrameBytes,
} from "./control-protocol.js";
import type { ClientState } from "./state.js";

export const maximumProjectedControlSnapshotBytes = 48 * 1_024;
const maximumTodayEntries = 50;

export type ControlSnapshotBase = Omit<
  ControlSnapshot,
  "todayEntries" | "todayEntryCount" | "todayEntriesOmitted"
>;

function compareEntryIds(left: string, right: string): number {
  if (left.length !== right.length) {
    return left.length - right.length;
  }
  return left.localeCompare(right);
}

export function chronologicalTodayEntries(state: ClientState): ControlTodayEntry[] {
  const rows = new Map<string, ControlTodayEntry>();
  for (const entry of state.entries.values()) {
    rows.set(entry.id, {
      id: entry.id,
      description: entry.description,
      projectId: entry.projectId,
      projectName: entry.projectName,
      projectColor: entry.projectColor,
      taskName: entry.taskName,
      start: entry.start,
      stop: entry.stop,
      durationSeconds: entry.durationSeconds,
    });
  }

  const current = state.current;
  if (current !== null && state.currentContributesToToday) {
    rows.set(current.id, {
      id: current.id,
      description: current.description,
      projectId: current.projectId,
      projectName: current.projectName,
      projectColor: current.projectColor,
      taskName: current.taskName,
      start: current.start,
      stop: null,
      durationSeconds: null,
    });
  }

  return [...rows.values()].sort((left, right) => {
    const timeDifference = Date.parse(right.start) - Date.parse(left.start);
    return timeDifference === 0 ? compareEntryIds(right.id, left.id) : timeDifference;
  });
}

export function boundedControlSnapshot(
  base: ControlSnapshotBase,
  entries: readonly ControlTodayEntry[],
  maximumBytes = maximumProjectedControlSnapshotBytes,
): ControlSnapshot {
  const todayEntryCount = entries.length;
  let snapshot: ControlSnapshot = {
    ...base,
    todayEntries: [],
    todayEntryCount,
    todayEntriesOmitted: todayEntryCount,
  };
  const selected: ControlTodayEntry[] = [];
  for (const entry of entries.slice(0, maximumTodayEntries)) {
    const nextEntries = [...selected, entry];
    const candidate: ControlSnapshot = {
      ...base,
      todayEntries: nextEntries,
      todayEntryCount,
      todayEntriesOmitted: todayEntryCount - nextEntries.length,
    };
    if (controlFrameBytes(candidate) > maximumBytes) {
      break;
    }
    selected.push(entry);
    snapshot = candidate;
  }
  return snapshot;
}
