import type { Weekday } from "../config/index.js";
import { WEEKDAYS } from "../config/index.js";

/**
 * Timezone handling — the single most common source of bugs in booking systems.
 *
 * The rule this whole codebase follows:
 *
 *   Every instant is stored and passed around as a UTC ISO string.
 *   Conversion to a local wall clock happens ONLY here, at the edges,
 *   using the business's IANA timezone.
 *
 * No other file calls `toLocaleString`, `getHours()`, or constructs a Date from
 * a wall-clock string. If you need a time formatted or parsed, add a function
 * here. That way daylight-saving bugs have exactly one place to hide.
 *
 * We do this with the built-in `Intl` API rather than a date library so the
 * dependency list stays small and the mechanism stays visible.
 */

/**
 * How far ahead of UTC the given zone is, at the given instant, in ms.
 *
 * Implementation note: `Intl` can format an instant into a zone, but it can't
 * directly tell you the offset. So we format the instant into the target zone,
 * read the wall-clock fields back, re-interpret those fields as if they were
 * UTC, and diff the two. The difference is the offset.
 */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23", // avoid the "24:00" that hour12:false can produce
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));

  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`Intl did not return a "${type}" part for zone ${timeZone}`);
    return Number(part.value);
  };

  const asIfUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asIfUtc - utcMs;
}

/**
 * Convert a wall-clock time in a zone to a UTC instant.
 *
 * Two passes: the first offset guess can be wrong for times near a DST
 * transition (the offset we need depends on the answer we're computing), so we
 * re-check with the corrected instant and adjust if the offset changed.
 *
 * Ambiguous times — the hour that repeats when clocks go back — resolve to one
 * of the two valid instants. Nonexistent times, the hour skipped when clocks go
 * forward, land just outside the gap. Both are acceptable here because we only
 * ever generate wall-clock times from business hours, and no gym opens at 2am.
 */
export function wallClockToUtc(
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const firstGuess = naive - zoneOffsetMs(naive, timeZone);
  const correctedOffset = zoneOffsetMs(firstGuess, timeZone);
  return new Date(naive - correctedOffset);
}

/** The wall-clock parts of a UTC instant, as seen in the given zone. */
export function partsInZone(
  instant: Date,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number; weekday: Weekday } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  }).formatToParts(instant);

  const raw = (type: Intl.DateTimeFormatPartTypes): string => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`Intl did not return a "${type}" part for zone ${timeZone}`);
    return part.value;
  };

  const weekday = raw("weekday").toLowerCase() as Weekday;
  if (!WEEKDAYS.includes(weekday)) {
    throw new Error(`Unexpected weekday "${weekday}" from Intl for zone ${timeZone}`);
  }

  return {
    year: Number(raw("year")),
    month: Number(raw("month")),
    day: Number(raw("day")),
    hour: Number(raw("hour")),
    minute: Number(raw("minute")),
    weekday,
  };
}

/** The weekday key ("mon", "tue", ...) an instant falls on, in the given zone. */
export function weekdayInZone(instant: Date, timeZone: string): Weekday {
  return partsInZone(instant, timeZone).weekday;
}

/** "2026-06-05" — the calendar date an instant falls on, in the given zone. */
export function dayKeyInZone(instant: Date, timeZone: string): string {
  const { year, month, day } = partsInZone(instant, timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Parse "2026-06-05" into its numeric parts. Throws on anything else. */
export function parseDayKey(dayKey: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) throw new Error(`Expected a date as YYYY-MM-DD, got "${dayKey}"`);
  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`"${dayKey}" is not a valid calendar date`);
  }
  return { year, month, day };
}

/** Parse "09:00" into hours and minutes. Throws on anything else. */
export function parseClockTime(value: string): { hour: number; minute: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) throw new Error(`Expected a time as HH:MM, got "${value}"`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** Advance a day key by N calendar days. Timezone-independent: pure date math. */
export function addDaysToDayKey(dayKey: string, days: number): string {
  const { year, month, day } = parseDayKey(dayKey);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(
    shifted.getUTCDate(),
  ).padStart(2, "0")}`;
}

/**
 * "Thursday, June 5 at 2:00 PM" — how a slot is described to a human.
 *
 * Both the customer and the model read this string, so it needs to be
 * unambiguous. We include the weekday because "the 5th" is meaningless to
 * someone scheduling their week.
 */
export function formatSlotForHumans(instant: Date, timeZone: string): string {
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(instant);

  const time = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(instant);

  return `${date} at ${time}`;
}

/** "2:00 PM" — just the clock time, for compact lists of same-day slots. */
export function formatTimeForHumans(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(instant);
}

/** "Thursday, June 5" — just the date, for grouping slots under a heading. */
export function formatDateForHumans(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(instant);
}

/**
 * The current date and time, described in the business's zone.
 * Injected into each user turn so the model can resolve "tomorrow" and "next
 * Thursday" without guessing — and without putting a timestamp in the cached
 * system prompt, which would break prompt caching on every single request.
 */
export function describeNow(now: Date, timeZone: string): string {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(now);
  return formatted;
}

/** Add minutes to an instant. */
export function addMinutes(instant: Date, minutes: number): Date {
  return new Date(instant.getTime() + minutes * 60_000);
}
