import type { ControlErrorCode, ControlSnapshot } from "./control-protocol.js";

export interface DrawerPresetRow {
  billable: boolean;
  id: string;
  label: string;
  project: string;
  tags: string[];
  task: string;
}

export interface DrawerView {
  confidence: ControlSnapshot["confidence"];
  connection: ControlSnapshot["connection"];
  current: {
    elapsed: string;
    label: string;
    project: string;
  } | null;
  error: string | null;
  pending: string | null;
  presets: DrawerPresetRow[];
  status: ControlSnapshot["status"];
  today: string;
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

export function drawerView(snapshot: ControlSnapshot, now = new Date().toISOString()): DrawerView {
  const currentElapsed = snapshot.current === null ? 0 : elapsedSince(snapshot.current.start, now);
  const today =
    snapshot.completedTodaySeconds + (snapshot.currentContributesToToday ? currentElapsed : 0);
  return {
    version: 1,
    status: snapshot.status,
    connection: snapshot.connection,
    confidence: snapshot.confidence,
    current:
      snapshot.current === null
        ? null
        : {
            label: snapshot.current.description || snapshot.current.projectName || "Running",
            project: snapshot.current.projectName ?? "",
            elapsed: formatDuration(currentElapsed),
          },
    today: formatDuration(today),
    pending:
      snapshot.pending === "stopping"
        ? "Stopping…"
        : snapshot.pending === "resuming"
          ? "Resuming…"
          : null,
    error: snapshot.error === null ? null : errorCopy[snapshot.error],
    presets: snapshot.presets.map((preset) => ({
      id: preset.id,
      label: preset.description || preset.taskName || preset.projectName || "Untitled activity",
      project: preset.projectName ?? "",
      task: preset.taskName ?? "",
      tags: [...preset.tags],
      billable: preset.billable,
    })),
  };
}
