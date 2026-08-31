import { describe, expect, it } from "vitest";

import { QuotaGate } from "../src/quota-gate.js";
import type { ApiResult } from "../src/toggl-api.js";

const minute = 60_000;

function success(remaining: number, resetsInSeconds = 600): ApiResult<null> {
  return {
    ok: true,
    data: null,
    quota: { remaining, resetsInSeconds },
  };
}

describe("quota gate", () => {
  it("schedules full and disconnected-current attempts at 10/5-minute cadence", () => {
    const gate = new QuotaGate();
    expect(gate.nextAction(0, true)).toBe("full");
    gate.recordAttempt("full", 0);

    expect(gate.nextAction(5 * minute - 1, false)).toBe("none");
    expect(gate.nextAction(5 * minute, false)).toBe("current");
    gate.recordAttempt("current", 5 * minute);
    expect(gate.nextAction(9 * minute, false)).toBe("none");
    expect(gate.nextAction(10 * minute, false)).toBe("full");
  });

  it("does not poll current while the relay is connected", () => {
    const gate = new QuotaGate();
    gate.recordAttempt("full", 0);

    expect(gate.nextAction(5 * minute, true)).toBe("none");
  });

  it("records attempts before I/O to prevent rapid retry loops", () => {
    const gate = new QuotaGate();
    const action = gate.nextAction(0, false);
    expect(action).toBe("full");
    gate.recordAttempt(action as "full", 0);

    expect(gate.nextAction(1, false)).toBe("none");
  });

  it("stops at the quota reserve and recovers at the advertised reset", () => {
    const gate = new QuotaGate();
    gate.record(success(6, 120), 0);

    expect(gate.allowsRequest(119_999)).toBe(false);
    expect(gate.nextAction(119_999, false)).toBe("none");
    expect(gate.allowsRequest(120_000)).toBe(true);
    expect(gate.nextAction(120_000, false)).toBe("full");
  });

  it("blocks a quota response even when the remaining header is absent", () => {
    const gate = new QuotaGate();
    gate.record(
      {
        ok: false,
        error: "quota_exhausted",
        mayHaveSucceeded: false,
        permanent: false,
        quota: { remaining: null, resetsInSeconds: 60 },
        status: 402,
      },
      0,
    );

    expect(gate.nextAction(59_999, false)).toBe("none");
    expect(gate.nextAction(60_000, false)).toBe("full");
  });

  it("caps a fully disconnected hour at 19 scheduled maintenance requests", () => {
    const gate = new QuotaGate();
    let currentRequests = 0;
    let fullRequests = 0;
    for (let now = 0; now < 60 * minute; now += minute) {
      const action = gate.nextAction(now, false);
      if (action === "none") {
        continue;
      }
      gate.recordAttempt(action, now);
      if (action === "full") {
        fullRequests += 2;
      } else {
        currentRequests += 1;
      }
    }

    const hourlyMonthRequests = 1;
    expect(fullRequests).toBe(12);
    expect(currentRequests).toBe(6);
    expect(fullRequests + currentRequests + hourlyMonthRequests).toBe(19);
  });
});
