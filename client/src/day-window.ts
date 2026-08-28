import { DateTime } from "luxon";

export interface DayWindow {
  dayKey: string;
  end: string;
  start: string;
}

export function dayWindowAt(instant: string | Date, timezone: string): DayWindow {
  const local =
    instant instanceof Date
      ? DateTime.fromJSDate(instant, { zone: timezone })
      : DateTime.fromISO(instant, { setZone: true }).setZone(timezone);
  if (!local.isValid) {
    throw new Error("Cannot derive local day from the supplied instant and timezone");
  }

  const start = local.startOf("day");
  const end = start.plus({ days: 1 });
  const dayKey = start.toISODate();
  const startUtc = start.toUTC().toISO();
  const endUtc = end.toUTC().toISO();
  if (dayKey === null || startUtc === null || endUtc === null) {
    throw new Error("Cannot serialize local day boundaries");
  }

  return { dayKey, start: startUtc, end: endUtc };
}

export function instantBelongsToDay(instant: string, window: DayWindow): boolean {
  const timestamp = Date.parse(instant);
  return timestamp >= Date.parse(window.start) && timestamp < Date.parse(window.end);
}
