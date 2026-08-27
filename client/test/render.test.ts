import { describe, expect, it } from "vitest";

import { renderWaybar } from "../src/render.js";
import type { RendererState } from "../src/state.js";

const generatedAt = "2026-08-27T12:00:00Z";

function rendererState(overrides: Partial<RendererState> = {}): RendererState {
  return {
    status: "running",
    connection: "connected",
    label: "PR review extremely long",
    description: "PR review extremely long",
    projectName: "Internal",
    entryStart: "2026-08-27T10:36:15Z",
    todayTrackedSeconds: 5_025,
    runningContributesToToday: true,
    generatedAt,
    lastSynchronizedAt: generatedAt,
    ...overrides,
  };
}

describe("Waybar rendering", () => {
  it("renders a compact connected timer with 12-character truncation", () => {
    expect(renderWaybar(rendererState(), generatedAt, { labelMaxChars: 12 })).toMatchObject({
      text: "▶ PR review e… 01:23:45",
      class: ["running", "connected"],
    });
  });

  it("ticks the entry and today's total locally", () => {
    const output = renderWaybar(rendererState(), "2026-08-27T12:00:05Z", {
      labelMaxChars: 12,
    });

    expect(output.text).toContain("01:23:50");
    expect(output.tooltip).toContain("Today: 01:23:50");
  });

  it.each([
    ["2026-08-27T11:59:55Z", "just now"],
    ["2026-08-27T11:59:18Z", "42s ago"],
    ["2026-08-27T11:52:00Z", "8m ago"],
    ["2026-08-27T09:00:00Z", "3h ago"],
    ["2026-08-25T12:00:00Z", "2d ago"],
  ])("shows a human sync age for %s", (lastSynchronizedAt, expectedAge) => {
    const output = renderWaybar(rendererState({ lastSynchronizedAt }), "2026-08-27T12:00:00Z", {
      labelMaxChars: 12,
    });

    expect(output.tooltip).toContain(`Last sync: ${expectedAge}`);
    expect(output.tooltip).not.toContain(lastSynchronizedAt);
  });

  it("renders idle, stale running, and offline states", () => {
    expect(
      renderWaybar(
        rendererState({
          status: "idle",
          label: null,
          description: null,
          projectName: null,
          entryStart: null,
          runningContributesToToday: false,
        }),
        generatedAt,
        { labelMaxChars: 12 },
      ).text,
    ).toBe("Today 01:23:45");

    expect(
      renderWaybar(rendererState({ connection: "stale" }), generatedAt, {
        labelMaxChars: 12,
      }),
    ).toMatchObject({ text: "⚠ PR review e… 01:23:45", class: ["running", "stale"] });

    expect(
      renderWaybar(rendererState({ status: "offline", connection: "offline" }), generatedAt, {
        labelMaxChars: 12,
      }),
    ).toEqual({ text: "Toggl offline", tooltip: "Toggl unavailable", class: ["offline"] });
  });

  it("falls back from an empty description to project name and then Running", () => {
    expect(
      renderWaybar(
        rendererState({ label: "Internal", description: "", projectName: "Internal" }),
        generatedAt,
        { labelMaxChars: 12 },
      ).text,
    ).toContain("Internal");
    expect(
      renderWaybar(
        rendererState({ label: "Running", description: "", projectName: null }),
        generatedAt,
        { labelMaxChars: 12 },
      ).text,
    ).toContain("Running");
  });

  it("keeps elapsed hours above 99 and truncates by Unicode code point", () => {
    expect(
      renderWaybar(
        rendererState({ label: "🧪🧪🧪", entryStart: "2026-08-23T08:00:00Z" }),
        generatedAt,
        { labelMaxChars: 2 },
      ).text,
    ).toBe("▶ 🧪… 100:00:00");
  });

  it("escapes Pango markup in tooltip fields", () => {
    const output = renderWaybar(
      rendererState({ description: "<review & fix>", projectName: 'R&D "core"' }),
      generatedAt,
      { labelMaxChars: 12 },
    );

    expect(output.tooltip).toContain("&lt;review &amp; fix&gt;");
    expect(output.tooltip).toContain("R&amp;D &quot;core&quot;");
    expect(output.tooltip).not.toContain("<review");
  });

  it("shows the full active timer without adding pre-midnight time to today's total", () => {
    const output = renderWaybar(
      rendererState({
        entryStart: "2026-08-26T20:30:00Z",
        todayTrackedSeconds: 0,
        runningContributesToToday: false,
      }),
      generatedAt,
      { labelMaxChars: 12 },
    );

    expect(output.text).toContain("15:30:00");
    expect(output.tooltip).toContain("Today: 00:00:00");
  });
});
