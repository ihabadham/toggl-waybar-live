import type {
  ControlErrorCode,
  ControlMonthProjection,
  ControlSnapshot,
  ControlTodayEntry,
} from "./control-protocol.js";
import { projectColor as validatedProjectColor } from "./project-color.js";

const mutedProjectColor = "#bfa894";

export interface DrawerContext {
  context: string;
  markerColor: string;
  markerVisible: boolean;
}

export interface DrawerCurrent extends DrawerContext {
  elapsed: string;
  label: string;
}

export interface DrawerPresetRow extends DrawerContext {
  id: string;
  label: string;
}

export interface DrawerTodayRow extends DrawerContext {
  duration: string;
  id: string;
  label: string;
  range: string;
  running: boolean;
}

export interface DrawerMonth {
  availability: ControlMonthProjection["availability"];
  cue: "" | "partial" | "stale" | "partial · stale";
  value: string;
}

export interface DrawerView {
  confidence: ControlSnapshot["confidence"];
  connection: ControlSnapshot["connection"];
  current: DrawerCurrent | null;
  error: string | null;
  month: DrawerMonth;
  pending: string | null;
  presets: DrawerPresetRow[];
  status: ControlSnapshot["status"];
  today: string;
  todayEntries: DrawerTodayRow[];
  todayEntriesOmitted: number;
  todayEntriesOmittedLabel: string;
  todayEntryCount: number;
  todayEntryCountLabel: string;
  version: 1;
}

const errorCopy: Record<ControlErrorCode, string> = {
  daemon_unavailable: "Toggl daemon unavailable",
  authentication_failed: "Toggl authentication failed",
  quota_exhausted: "Toggl request quota exhausted",
  state_unconfirmed: "Timer state could not be confirmed",
  ambiguous_create: "Timer may have started; waiting for confirmation",
  preset_not_found: "That recent activity is no longer available",
  command_busy: "Another Toggl command is still running",
  request_failed: "Toggl request failed",
};

function elapsedSince(start: string, now: string): number {
  return Math.max(0, (Date.parse(now) - Date.parse(start)) / 1_000);
}

function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3_600);
  const minutes = Math.floor((whole % 3_600) / 60);
  const remaining = whole % 60;
  return [hours, minutes, remaining].map((part) => String(part).padStart(2, "0")).join(":");
}

function formatMonthDuration(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3_600);
  const minutes = Math.floor((whole % 3_600) / 60);
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

function displayLabel(
  description: string,
  projectName: string | null,
  taskName: string | null,
): string {
  return description || taskName || projectName || "Untitled activity";
}

function displayContext(projectName: string | null, taskName: string | null): string {
  const project = projectName || "";
  const task = taskName || "";
  if (project === task) {
    return project;
  }
  return [project, task].filter((part) => part !== "").join(" · ");
}

function drawerContext(
  projectId: string | null,
  projectName: string | null,
  taskName: string | null,
  color: string | null,
): DrawerContext {
  const markerColor = validatedProjectColor(color);
  return {
    context: displayContext(projectName, taskName),
    markerColor: markerColor ?? mutedProjectColor,
    markerVisible: projectId !== null || projectName !== null || markerColor !== null,
  };
}

function completedDuration(entry: ControlTodayEntry): number {
  if (entry.durationSeconds !== null) {
    return entry.durationSeconds;
  }
  return entry.stop === null
    ? 0
    : Math.max(0, (Date.parse(entry.stop) - Date.parse(entry.start)) / 1_000);
}

function monthView(month: ControlMonthProjection, currentElapsed: number): DrawerMonth {
  if (month.availability === "unavailable") {
    return { availability: month.availability, value: "—", cue: "" };
  }

  const duration = month.completedSeconds + (month.currentContributes ? currentElapsed : 0);
  const cue = month.partial
    ? month.availability === "stale"
      ? "partial · stale"
      : "partial"
    : month.availability === "stale"
      ? "stale"
      : "";
  return {
    availability: month.availability,
    value: `${month.partial ? "≥ " : ""}${formatMonthDuration(duration)}`,
    cue,
  };
}

function omittedEntriesLabel(count: number): string {
  if (count === 0) {
    return "";
  }
  return `${count} earlier ${count === 1 ? "entry" : "entries"} not shown`;
}

export function drawerView(snapshot: ControlSnapshot, now = new Date().toISOString()): DrawerView {
  const currentElapsed = snapshot.current === null ? 0 : elapsedSince(snapshot.current.start, now);
  const today =
    snapshot.completedTodaySeconds + (snapshot.currentContributesToToday ? currentElapsed : 0);
  const timeFormatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: snapshot.timezone ?? "UTC",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const todayEntries = snapshot.todayEntries.map((entry): DrawerTodayRow => {
    const running = entry.stop === null;
    const duration = running ? currentElapsed : completedDuration(entry);
    const stop = entry.stop === null ? "Now" : timeFormatter.format(new Date(entry.stop));
    return {
      id: entry.id,
      label: displayLabel(entry.description, entry.projectName, entry.taskName),
      ...drawerContext(entry.projectId, entry.projectName, entry.taskName, entry.projectColor),
      range: `${timeFormatter.format(new Date(entry.start))} – ${stop}`,
      duration: formatDuration(duration),
      running,
    };
  });

  return {
    version: 1,
    status: snapshot.status,
    connection: snapshot.connection,
    confidence: snapshot.confidence,
    current:
      snapshot.current === null
        ? null
        : {
            label: displayLabel(
              snapshot.current.description,
              snapshot.current.projectName,
              snapshot.current.taskName,
            ),
            ...drawerContext(
              snapshot.current.projectId,
              snapshot.current.projectName,
              snapshot.current.taskName,
              snapshot.current.projectColor,
            ),
            elapsed: formatDuration(currentElapsed),
          },
    today: formatDuration(today),
    todayEntryCount: snapshot.todayEntryCount,
    todayEntryCountLabel: `${snapshot.todayEntryCount} ${snapshot.todayEntryCount === 1 ? "entry" : "entries"}`,
    todayEntries,
    todayEntriesOmitted: snapshot.todayEntriesOmitted,
    todayEntriesOmittedLabel: omittedEntriesLabel(snapshot.todayEntriesOmitted),
    month: monthView(snapshot.month, currentElapsed),
    pending:
      snapshot.pending === "stopping"
        ? "Stopping…"
        : snapshot.pending === "resuming"
          ? "Resuming…"
          : null,
    error: snapshot.error === null ? null : errorCopy[snapshot.error],
    presets: snapshot.presets.map((preset) => ({
      id: preset.id,
      label: displayLabel(preset.description, preset.projectName, preset.taskName),
      ...drawerContext(preset.projectId, preset.projectName, preset.taskName, preset.projectColor),
    })),
  };
}
