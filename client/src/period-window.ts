import { DateTime } from "luxon";

export interface PeriodWindow {
  end: string;
  monthKey: string;
  monthStart: string;
  start: string;
  weekKey: string;
  weekEnd: string;
  weekStart: string;
}

export function periodWindowAt(
  instant: string | Date,
  timezone: string,
  beginningOfWeek: number,
): PeriodWindow {
  const local =
    instant instanceof Date
      ? DateTime.fromJSDate(instant, { zone: timezone })
      : DateTime.fromISO(instant, { setZone: true }).setZone(timezone);
  if (
    !local.isValid ||
    !Number.isInteger(beginningOfWeek) ||
    beginningOfWeek < 0 ||
    beginningOfWeek > 6
  ) {
    throw new Error("Cannot derive reporting periods from the supplied settings");
  }

  const monthStart = local.startOf("month");
  const localWeekday = local.weekday % 7;
  const weekStart = local.startOf("day").minus({
    days: (localWeekday - beginningOfWeek + 7) % 7,
  });
  const start = DateTime.min(monthStart, weekStart);
  const weekEnd = weekStart.plus({ days: 7 });
  const end = monthStart.plus({ months: 1 });
  const serialize = (value: DateTime): string => {
    const serialized = value.toUTC().toISO();
    if (serialized === null) {
      throw new Error("Cannot serialize reporting period boundaries");
    }
    return serialized;
  };

  return {
    start: serialize(start),
    monthStart: serialize(monthStart),
    weekStart: serialize(weekStart),
    weekEnd: serialize(weekEnd),
    end: serialize(end),
    monthKey: monthStart.toFormat("yyyy-MM"),
    weekKey: weekStart.toFormat("yyyy-MM-dd"),
  };
}

function belongsTo(instant: string, start: string, end: string): boolean {
  const timestamp = Date.parse(instant);
  return timestamp >= Date.parse(start) && timestamp < Date.parse(end);
}

export function instantBelongsToPeriod(instant: string, window: PeriodWindow): boolean {
  return belongsTo(instant, window.start, window.end);
}

export function instantBelongsToMonth(instant: string, window: PeriodWindow): boolean {
  return belongsTo(instant, window.monthStart, window.end);
}

export function instantBelongsToWeek(instant: string, window: PeriodWindow): boolean {
  return belongsTo(instant, window.weekStart, window.weekEnd);
}
