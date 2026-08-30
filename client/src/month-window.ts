import { DateTime } from "luxon";

export interface MonthWindow {
  end: string;
  monthKey: string;
  start: string;
}

export function monthWindowAt(instant: string | Date, timezone: string): MonthWindow {
  const local =
    instant instanceof Date
      ? DateTime.fromJSDate(instant, { zone: timezone })
      : DateTime.fromISO(instant, { setZone: true }).setZone(timezone);
  if (!local.isValid) {
    throw new Error("Cannot derive local month from the supplied instant and timezone");
  }

  const start = local.startOf("month");
  const end = start.plus({ months: 1 });
  const monthKey = start.toFormat("yyyy-MM");
  const startUtc = start.toUTC().toISO();
  const endUtc = end.toUTC().toISO();
  if (startUtc === null || endUtc === null) {
    throw new Error("Cannot serialize local month boundaries");
  }

  return { monthKey, start: startUtc, end: endUtc };
}

export function instantBelongsToMonth(instant: string, window: MonthWindow): boolean {
  const timestamp = Date.parse(instant);
  return timestamp >= Date.parse(window.start) && timestamp < Date.parse(window.end);
}
