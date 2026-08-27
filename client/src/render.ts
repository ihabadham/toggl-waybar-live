import type { RendererState } from "./state.js";

export interface RenderOptions {
  labelMaxChars: number;
}

export interface WaybarOutput {
  text: string;
  tooltip: string;
  class: string[];
}

function formatDuration(seconds: number): string {
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(wholeSeconds / 3_600);
  const minutes = Math.floor((wholeSeconds % 3_600) / 60);
  const remainingSeconds = wholeSeconds % 60;
  return [hours, minutes, remainingSeconds].map((part) => String(part).padStart(2, "0")).join(":");
}

function truncate(value: string, limit: number): string {
  const characters = Array.from(value);
  if (characters.length <= limit) {
    return value;
  }
  return limit === 1 ? "…" : `${characters.slice(0, limit - 1).join("")}…`;
}

function escapeMarkup(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function elapsedSince(start: string, now: string): number {
  return Math.max(0, (Date.parse(now) - Date.parse(start)) / 1_000);
}

function todayAt(state: RendererState, now: string): number {
  return (
    state.todayTrackedSeconds +
    (state.runningContributesToToday ? elapsedSince(state.generatedAt, now) : 0)
  );
}

function tooltip(state: RendererState, now: string): string {
  const lines: string[] = [];
  if (state.status === "running") {
    lines.push(escapeMarkup(state.description || state.projectName || "Running"));
    if (state.projectName) {
      lines.push(`Project: ${escapeMarkup(state.projectName)}`);
    }
  }
  lines.push(`Today: ${formatDuration(todayAt(state, now))}`);
  if (state.lastSynchronizedAt) {
    lines.push(`Last sync: ${escapeMarkup(state.lastSynchronizedAt)}`);
  }
  if (state.connection === "stale") {
    lines.push("Connection stale");
  }
  return lines.join("\n");
}

export function renderWaybar(
  state: RendererState,
  now: string,
  options: RenderOptions,
): WaybarOutput {
  if (state.status === "offline") {
    return { text: "Toggl offline", tooltip: "Toggl unavailable", class: ["offline"] };
  }

  const today = formatDuration(todayAt(state, now));
  if (state.status === "idle") {
    return {
      text: `${state.connection === "stale" ? "⚠ " : ""}Today ${today}`,
      tooltip: tooltip(state, now),
      class: ["idle", state.connection],
    };
  }

  if (state.entryStart === null) {
    return { text: "Toggl offline", tooltip: "Toggl unavailable", class: ["offline"] };
  }

  const label = truncate(state.label || "Running", options.labelMaxChars);
  const active = formatDuration(elapsedSince(state.entryStart, now));
  return {
    text: `${state.connection === "stale" ? "⚠" : "▶"} ${label} ${active}`,
    tooltip: tooltip(state, now),
    class: ["running", state.connection],
  };
}
