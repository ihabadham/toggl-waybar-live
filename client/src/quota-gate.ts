import type { ApiResult } from "./toggl-api.js";

export type ReconciliationAction = "full" | "current" | "none";

const fullIntervalMilliseconds = 10 * 60 * 1_000;
const currentIntervalMilliseconds = 5 * 60 * 1_000;
const fallbackQuotaBlockMilliseconds = 60 * 60 * 1_000;
const minimumQuotaReserve = 6;

export class QuotaGate {
  private blockedUntil: number | null = null;
  private lastCurrentAttempt: number | null = null;
  private lastFullAttempt: number | null = null;

  nextAction(now: number, relayConnected: boolean): ReconciliationAction {
    if (this.blockedUntil !== null) {
      if (now < this.blockedUntil) {
        return "none";
      }
      this.blockedUntil = null;
    }

    if (this.lastFullAttempt === null || now - this.lastFullAttempt >= fullIntervalMilliseconds) {
      return "full";
    }
    if (
      !relayConnected &&
      (this.lastCurrentAttempt === null ||
        now - this.lastCurrentAttempt >= currentIntervalMilliseconds)
    ) {
      return "current";
    }
    return "none";
  }

  recordAttempt(action: Exclude<ReconciliationAction, "none">, now: number): void {
    if (action === "full") {
      this.lastFullAttempt = now;
      this.lastCurrentAttempt = now;
    } else {
      this.lastCurrentAttempt = now;
    }
  }

  record(result: ApiResult<unknown>, now: number): void {
    const quotaExhausted = !result.ok && result.error === "quota_exhausted";
    const quotaLow =
      result.quota.remaining !== null && result.quota.remaining <= minimumQuotaReserve;
    if (!quotaExhausted && !quotaLow) {
      return;
    }

    this.blockedUntil =
      now +
      (result.quota.resetsInSeconds === null
        ? fallbackQuotaBlockMilliseconds
        : result.quota.resetsInSeconds * 1_000);
  }
}
