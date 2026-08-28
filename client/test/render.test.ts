import { describe, expect, it } from "vitest";

import { renderWaybar } from "../src/render.js";
import type { RendererState } from "../src/state.js";

const generatedAt = "2026-08-27T12:00:00Z";

function plainMarkup(value: string): string {
  return value.replaceAll(/<[^>]+>/g, "");
}

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
    const output = renderWaybar(rendererState(), generatedAt, { labelMaxChars: 12 });

    expect(output).toMatchObject({
      class: ["running", "connected"],
    });
    expect(plainMarkup(output.text)).toBe("● PR review e…  │ 01:23:45 · Σ01:23");
    expect(output.text).toContain('foreground="#E57CD8" alpha="100%"');
    expect(output.text).toContain('background="#2B2321"');
  });

  it("ticks the entry and today's total locally", () => {
    const output = renderWaybar(rendererState(), "2026-08-27T12:00:05Z", {
      labelMaxChars: 12,
    });

    expect(plainMarkup(output.text)).toContain("01:23:50");
    expect(plainMarkup(output.text)).toContain("Σ01:23");
    expect(plainMarkup(output.tooltip)).toContain("Today     01:23:50");
    expect(output.tooltip).toContain("<b>PR review extremely long</b>");
    expect(plainMarkup(output.tooltip)).toContain("Relay connected · full sync just now");
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

    expect(plainMarkup(output.tooltip)).toContain(`full sync ${expectedAge}`);
    expect(output.tooltip).not.toContain(lastSynchronizedAt);
  });

  it("renders idle, stale running, and offline states", () => {
    const idle = renderWaybar(
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
    );
    expect(plainMarkup(idle.text)).toBe("○ Today  │ 01:23:45 ");
    expect(idle.text).toContain('background="#28211F"');

    const stale = renderWaybar(rendererState({ connection: "stale" }), generatedAt, {
      labelMaxChars: 12,
    });
    expect(stale.class).toEqual(["running", "stale"]);
    expect(plainMarkup(stale.text)).toBe("⚠ PR review e…  │ 01:23:45 · Σ01:23");
    expect(stale.text).toContain('background="#2B2718"');
    expect(plainMarkup(stale.tooltip)).toContain("Relay stale · full sync just now");

    const offline = renderWaybar(
      rendererState({ status: "offline", connection: "offline" }),
      generatedAt,
      { labelMaxChars: 12 },
    );
    expect(offline.class).toEqual(["offline"]);
    expect(plainMarkup(offline.text)).toBe("● Toggl offline");
    expect(plainMarkup(offline.tooltip)).toContain("Relay offline");
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
    const output = renderWaybar(
      rendererState({ label: "🧪🧪🧪", entryStart: "2026-08-23T08:00:00Z" }),
      generatedAt,
      { labelMaxChars: 2 },
    );
    expect(plainMarkup(output.text)).toBe("● 🧪…  │ 100:00:00 · Σ01:23");
  });

  it("floors the compact total to minutes and advances across a minute boundary", () => {
    const state = rendererState({ todayTrackedSeconds: 45_659 });
    const before = renderWaybar(state, generatedAt, { labelMaxChars: 12 });
    const after = renderWaybar(state, "2026-08-27T12:00:01Z", { labelMaxChars: 12 });

    expect(plainMarkup(before.text)).toContain("Σ12:40");
    expect(plainMarkup(after.text)).toContain("Σ12:41");
  });

  it("pulses only the running activity dot", () => {
    const even = renderWaybar(rendererState(), "2026-08-27T12:00:00Z", { labelMaxChars: 12 });
    const odd = renderWaybar(rendererState(), "2026-08-27T12:00:01Z", { labelMaxChars: 12 });

    expect(even.text).toContain('alpha="100%"');
    expect(odd.text).toContain('alpha="55%"');
    expect(plainMarkup(even.text).replace("01:23:45", "timer")).toBe(
      plainMarkup(odd.text).replace("01:23:46", "timer"),
    );
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
    expect(output.text).not.toContain("<review");
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
    expect(plainMarkup(output.text)).toContain("Σ00:00");
    expect(plainMarkup(output.tooltip)).toContain("Today     00:00:00");
  });
});
