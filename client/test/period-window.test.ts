import { describe, expect, it } from "vitest";

import { periodWindowAt } from "../src/period-window.js";

describe("reporting period window", () => {
  it("honors a Sunday-start Toggl week across a month boundary", () => {
    expect(periodWindowAt("2026-09-01T12:00:00Z", "Africa/Cairo", 0)).toEqual({
      start: "2026-08-29T21:00:00.000Z",
      monthStart: "2026-08-31T21:00:00.000Z",
      weekStart: "2026-08-29T21:00:00.000Z",
      weekEnd: "2026-09-05T21:00:00.000Z",
      end: "2026-09-30T21:00:00.000Z",
      monthKey: "2026-09",
      weekKey: "2026-08-30",
    });
  });

  it("uses local calendar days across daylight-saving changes", () => {
    const window = periodWindowAt("2026-03-10T12:00:00Z", "America/New_York", 0);
    expect(window.weekStart).toBe("2026-03-08T05:00:00.000Z");
    expect(window.weekEnd).toBe("2026-03-15T04:00:00.000Z");
  });

  it("honors a Monday-start Toggl week", () => {
    const window = periodWindowAt("2026-09-05T12:00:00Z", "Africa/Cairo", 1);
    expect(window.weekKey).toBe("2026-08-31");
    expect(window.weekStart).toBe("2026-08-30T21:00:00.000Z");
    expect(window.start).toBe(window.weekStart);
  });
});
