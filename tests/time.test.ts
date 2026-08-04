import { describe, expect, it } from "vitest";
import {
  addDaysToDayKey,
  dayKeyInZone,
  formatSlotForHumans,
  parseClockTime,
  parseDayKey,
  wallClockToUtc,
  weekdayInZone,
} from "../src/util/time.js";

/**
 * Timezone conversion is the part of a booking system that fails silently and
 * embarrassingly — an appointment an hour off, or on the wrong day, once a year
 * when the clocks change. So it gets tested against known-correct fixed points.
 */
describe("wallClockToUtc", () => {
  const NY = "America/New_York";

  it("converts a standard-time (EST, UTC-5) wall clock", () => {
    // 2026-01-15 09:00 in New York is 14:00 UTC.
    expect(wallClockToUtc(2026, 1, 15, 9, 0, NY).toISOString()).toBe("2026-01-15T14:00:00.000Z");
  });

  it("converts a daylight-time (EDT, UTC-4) wall clock", () => {
    // 2026-07-15 09:00 in New York is 13:00 UTC — one hour less than winter.
    expect(wallClockToUtc(2026, 7, 15, 9, 0, NY).toISOString()).toBe("2026-07-15T13:00:00.000Z");
  });

  it("handles the day the clocks spring forward", () => {
    // DST starts 2026-03-08. 09:00 that morning is already EDT, so 13:00 UTC.
    expect(wallClockToUtc(2026, 3, 8, 9, 0, NY).toISOString()).toBe("2026-03-08T13:00:00.000Z");
  });

  it("handles the day the clocks fall back", () => {
    // DST ends 2026-11-01. By 09:00 we're back on EST, so 14:00 UTC.
    expect(wallClockToUtc(2026, 11, 1, 9, 0, NY).toISOString()).toBe("2026-11-01T14:00:00.000Z");
  });

  it("round-trips through the zone it came from", () => {
    const utc = wallClockToUtc(2026, 6, 5, 14, 30, NY);
    expect(dayKeyInZone(utc, NY)).toBe("2026-06-05");
    expect(formatSlotForHumans(utc, NY)).toBe("Friday, June 5 at 2:30 PM");
  });

  it("puts a late-evening local time on the correct local day", () => {
    // 8:30pm in Portland is 00:30 the NEXT day in UTC. Naive UTC-day handling
    // would file this under the wrong date and drop it from availability.
    const utc = wallClockToUtc(2026, 6, 5, 20, 30, NY);
    expect(utc.toISOString()).toBe("2026-06-06T00:30:00.000Z");
    expect(dayKeyInZone(utc, NY)).toBe("2026-06-05");
  });
});

describe("weekdayInZone", () => {
  it("reports the local weekday, not the UTC one", () => {
    // 2026-06-06T00:30Z is Saturday in UTC but still Friday in New York.
    expect(weekdayInZone(new Date("2026-06-06T00:30:00.000Z"), "America/New_York")).toBe("fri");
    expect(weekdayInZone(new Date("2026-06-06T00:30:00.000Z"), "UTC")).toBe("sat");
  });
});

describe("day key helpers", () => {
  it("parses a valid key", () => {
    expect(parseDayKey("2026-06-05")).toEqual({ year: 2026, month: 6, day: 5 });
  });

  it("rejects malformed input rather than guessing", () => {
    expect(() => parseDayKey("June 5")).toThrow(/YYYY-MM-DD/);
    expect(() => parseDayKey("2026-13-01")).toThrow(/not a valid calendar date/);
  });

  it("rolls over month and year boundaries", () => {
    expect(addDaysToDayKey("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDaysToDayKey("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysToDayKey("2028-02-28", 1)).toBe("2028-02-29"); // leap year
  });
});

describe("parseClockTime", () => {
  it("accepts 24-hour times", () => {
    expect(parseClockTime("05:00")).toEqual({ hour: 5, minute: 0 });
    expect(parseClockTime("21:30")).toEqual({ hour: 21, minute: 30 });
  });

  it("rejects anything else", () => {
    expect(() => parseClockTime("9am")).toThrow(/HH:MM/);
    expect(() => parseClockTime("25:00")).toThrow(/HH:MM/);
  });
});
