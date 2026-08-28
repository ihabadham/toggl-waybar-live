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

function colored(value: string, color: string): string {
  return `<span foreground="${color}">${value}</span>`;
}

function timerSegment(value: string, color: string, background: string): string {
  return `<span foreground="${color}" background="${background}"> │ ${value} </span>`;
}

function elapsedSince(start: string, now: string): number {
  return Math.max(0, (Date.parse(now) - Date.parse(start)) / 1_000);
}

function formatRelativeAge(start: string, now: string): string {
  const seconds = Math.floor(elapsedSince(start, now));
  if (seconds < 10) {
    return "just now";
  }
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

function formatStartTime(start: string, now: string): string {
  const includeDate = elapsedSince(start, now) >= 86_400;
  return new Intl.DateTimeFormat(undefined, {
    ...(includeDate ? { month: "short", day: "numeric" } : {}),
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(start));
}

function todayAt(state: RendererState, now: string): number {
  return (
    state.todayTrackedSeconds +
    (state.runningContributesToToday ? elapsedSince(state.generatedAt, now) : 0)
  );
}

function relayStatus(state: RendererState, now: string): string {
  const synchronized = state.lastSynchronizedAt
    ? ` · full sync ${formatRelativeAge(state.lastSynchronizedAt, now)}`
    : "";
  if (state.connection === "connected") {
    return `${colored("●", "#A5C37A")} ${colored(`Relay connected${synchronized}`, "#A99D88")}`;
  }
  if (state.connection === "stale") {
    return `${colored("⚠", "#D6A84F")} ${colored(`Relay stale${synchronized}`, "#D6A84F")}`;
  }
  return `${colored("●", "#937A5C")} ${colored("Relay offline", "#937A5C")}`;
}

function detail(label: string, value: string): string {
  return `${colored(label.padEnd(10), "#A99D88")}${value}`;
}

function tooltip(state: RendererState, now: string): string {
  const divider = colored("────────────────────────────", "#5B503B");
  const today = formatDuration(todayAt(state, now));
  if (state.status === "running" && state.entryStart) {
    const title = escapeMarkup(state.description || state.projectName || "Running");
    const active = formatDuration(elapsedSince(state.entryStart, now));
    const project = escapeMarkup(state.projectName || "Unassigned");
    return [
      `<b>${title}</b>`,
      `${colored("● TRACKING", "#C98CAF")}                 ${colored(`<b>${active}</b>`, "#D5A59B")}`,
      divider,
      `<tt>${detail("Project", project)}\n${detail("Started", formatStartTime(state.entryStart, now))}\n${detail("Today", today)}</tt>`,
      divider,
      relayStatus(state, now),
    ].join("\n");
  }

  return [
    "<b>Toggl Track</b>",
    colored("○ NO TIMER RUNNING", "#D5A59B"),
    divider,
    `<tt>${detail("Today", today)}</tt>`,
    divider,
    relayStatus(state, now),
  ].join("\n");
}

function runningText(label: string, active: string, now: string): string {
  const pulseAlpha = new Date(now).getUTCSeconds() % 2 === 0 ? "100%" : "55%";
  return [
    `<span foreground="#E57CD8" alpha="${pulseAlpha}">●</span>`,
    colored(escapeMarkup(label), "#C98CAF"),
    timerSegment(active, "#D5A59B", "#2B2321"),
  ].join(" ");
}

export function renderWaybar(
  state: RendererState,
  now: string,
  options: RenderOptions,
): WaybarOutput {
  if (state.status === "offline") {
    return {
      text: colored("● Toggl offline", "#937A5C"),
      tooltip: `<b>Toggl Track</b>\n${relayStatus(state, now)}`,
      class: ["offline"],
    };
  }

  const today = formatDuration(todayAt(state, now));
  if (state.status === "idle") {
    return {
      text:
        state.connection === "stale"
          ? `${colored("⚠ Today", "#D6A84F")} ${timerSegment(today, "#D6A84F", "#2B2718")}`
          : `${colored("○", "#D5A59B")} ${colored("Today", "#C98CAF")} ${timerSegment(today, "#D5A59B", "#28211F")}`,
      tooltip: tooltip(state, now),
      class: ["idle", state.connection],
    };
  }

  if (state.entryStart === null) {
    return {
      text: colored("● Toggl offline", "#937A5C"),
      tooltip: `<b>Toggl Track</b>\n${relayStatus({ ...state, connection: "offline" }, now)}`,
      class: ["offline"],
    };
  }

  const label = truncate(state.label || "Running", options.labelMaxChars);
  const active = formatDuration(elapsedSince(state.entryStart, now));
  return {
    text:
      state.connection === "stale"
        ? `${colored(`⚠ ${escapeMarkup(label)}`, "#D6A84F")} ${timerSegment(active, "#D6A84F", "#2B2718")}`
        : runningText(label, active, now),
    tooltip: tooltip(state, now),
    class: ["running", state.connection],
  };
}
