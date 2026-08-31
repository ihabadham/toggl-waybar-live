import { describe, expect, it } from "vitest";

import { instantBelongsToMonth, monthWindowAt } from "../src/month-window.js";

describe("local month windows", () => {
  it("uses local Cairo boundaries across the spring DST transition", () => {
    expect(monthWindowAt("2026-04-15T12:00:00Z", "Africa/Cairo")).toEqual({
      monthKey: "2026-04",
      start: "2026-03-31T22:00:00.000Z",
      end: "2026-04-30T21:00:00.000Z",
    });
  });

  it("uses local Cairo boundaries across the autumn DST transition", () => {
    expect(monthWindowAt("2026-10-15T12:00:00Z", "Africa/Cairo")).toEqual({
      monthKey: "2026-10",
      start: "2026-09-30T21:00:00.000Z",
      end: "2026-10-31T22:00:00.000Z",
    });
  });

  it("uses start-inclusive and end-exclusive membership", () => {
    const window = monthWindowAt("2026-08-15T12:00:00Z", "Africa/Cairo");

    expect(instantBelongsToMonth(window.start, window)).toBe(true);
    expect(instantBelongsToMonth("2026-08-31T20:59:59.999Z", window)).toBe(true);
    expect(instantBelongsToMonth(window.end, window)).toBe(false);
  });
});
