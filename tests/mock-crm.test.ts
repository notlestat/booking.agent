import { beforeEach, describe, expect, it } from "vitest";
import { business } from "../src/config/index.js";
import { MockCrm } from "../src/crm/mock.js";
import { SlotTakenError, UnknownSlotError } from "../src/crm/types.js";
import { dayKeyInZone, weekdayInZone } from "../src/util/time.js";

/**
 * The mock CRM is the reference implementation of the CrmAdapter contract.
 * These tests describe what any adapter has to do — including the GoHighLevel
 * one — so they double as the spec for that adapter.
 */

// A fixed "now" so availability is deterministic: Mon 1 Jun 2026, 09:00 UTC.
const NOW = new Date("2026-06-01T09:00:00.000Z");
const WINDOW_START = "2026-06-01T00:00:00.000Z";
const WINDOW_END = "2026-06-08T00:00:00.000Z";

let crm: MockCrm;

beforeEach(() => {
  crm = new MockCrm(() => NOW);
});

describe("contacts", () => {
  it("creates a contact", async () => {
    const contact = await crm.findOrCreateContact({ firstName: "Dana", email: "dana@example.com" });
    expect(contact.id).toMatch(/^contact_/);
    expect(contact.firstName).toBe("Dana");
  });

  it("returns the same contact for the same email rather than duplicating", async () => {
    const first = await crm.findOrCreateContact({ firstName: "Dana", email: "dana@example.com" });
    const second = await crm.findOrCreateContact({ firstName: "Dana", email: "DANA@example.com" });
    expect(second.id).toBe(first.id);
    expect(crm.snapshot().contacts).toHaveLength(1);
  });

  it("matches on phone regardless of formatting", async () => {
    const first = await crm.findOrCreateContact({ firstName: "Sam", phone: "(555) 014-2280" });
    const second = await crm.findOrCreateContact({ firstName: "Sam", phone: "555-014-2280" });
    expect(second.id).toBe(first.id);
  });

  it("merges newly-supplied details into an existing contact", async () => {
    await crm.findOrCreateContact({ firstName: "Dana", email: "dana@example.com" });
    const updated = await crm.findOrCreateContact({
      firstName: "Dana",
      email: "dana@example.com",
      phone: "555-111-2222",
    });
    expect(updated.phone).toBe("555-111-2222");
    expect(crm.snapshot().contacts).toHaveLength(1);
  });
});

describe("availability", () => {
  it("returns slots for a real service", async () => {
    const slots = await crm.getAvailableSlots("intro-session", WINDOW_START, WINDOW_END);
    expect(slots.length).toBeGreaterThan(0);
  });

  it("returns nothing for a service that doesn't exist", async () => {
    expect(await crm.getAvailableSlots("massage", WINDOW_START, WINDOW_END)).toEqual([]);
  });

  it("respects the minimum-notice rule", async () => {
    const slots = await crm.getAvailableSlots("intro-session", WINDOW_START, WINDOW_END);
    const floor = NOW.getTime() + business.booking.minNoticeHours * 3_600_000;
    for (const slot of slots) {
      expect(new Date(slot.startsAt).getTime()).toBeGreaterThanOrEqual(floor);
    }
  });

  it("never offers a slot outside the gym's opening hours", async () => {
    const slots = await crm.getAvailableSlots("intro-session", WINDOW_START, WINDOW_END);
    const service = business.services.find((s) => s.id === "intro-session")!;

    for (const slot of slots) {
      const start = new Date(slot.startsAt);
      const weekday = weekdayInZone(start, business.timezone);
      const ranges = business.hours[weekday] ?? [];
      expect(ranges.length).toBeGreaterThan(0);

      const localMinutes = localMinutesOfDay(start);
      const fitsInSomeRange = ranges.some((range) => {
        const open = toMinutes(range.open);
        const close = toMinutes(range.close);
        return localMinutes >= open && localMinutes + service.durationMinutes <= close;
      });
      expect(fitsInSomeRange, `${slot.startsAt} falls outside ${weekday} hours`).toBe(true);
    }
  });

  it("returns slots in chronological order", async () => {
    const slots = await crm.getAvailableSlots("intro-session", WINDOW_START, WINDOW_END);
    const sorted = [...slots].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    expect(slots).toEqual(sorted);
  });

  it("is deterministic — the same slot has the same id every call", async () => {
    const first = await crm.getAvailableSlots("intro-session", WINDOW_START, WINDOW_END);
    const second = await crm.getAvailableSlots("intro-session", WINDOW_START, WINDOW_END);
    expect(second.map((s) => s.id)).toEqual(first.map((s) => s.id));
  });

  it("leaves realistic gaps rather than showing every slot free", async () => {
    // If everything were free the demo would look fake and the "that time's
    // taken" path would never be exercised.
    const slots = await crm.getAvailableSlots("intro-session", WINDOW_START, WINDOW_END);
    const byDay = new Map<string, number>();
    for (const slot of slots) {
      const key = dayKeyInZone(new Date(slot.startsAt), business.timezone);
      byDay.set(key, (byDay.get(key) ?? 0) + 1);
    }
    // A 5am-9pm day at 30-minute intervals would be ~31 slots if all were open.
    for (const count of byDay.values()) expect(count).toBeLessThan(31);
  });
});

describe("booking", () => {
  it("books an offered slot", async () => {
    const [slot] = await crm.getAvailableSlots("intro-session", WINDOW_START, WINDOW_END);
    const contact = await crm.findOrCreateContact({ firstName: "Dana", email: "dana@example.com" });

    const appointment = await crm.bookAppointment({
      slotId: slot!.id,
      contactId: contact.id,
      serviceId: "intro-session",
    });

    expect(appointment.status).toBe("booked");
    expect(appointment.startsAt).toBe(slot!.startsAt);
    expect(crm.snapshot().appointments).toHaveLength(1);
  });

  it("rejects a fabricated slot id", async () => {
    const contact = await crm.findOrCreateContact({ firstName: "Dana", email: "dana@example.com" });
    await expect(
      crm.bookAppointment({
        slotId: "slot_deadbeefdeadbeef",
        contactId: contact.id,
        serviceId: "intro-session",
      }),
    ).rejects.toThrow(UnknownSlotError);
  });

  it("refuses to double-book — the second attempt loses", async () => {
    const [slot] = await crm.getAvailableSlots("intro-session", WINDOW_START, WINDOW_END);
    const first = await crm.findOrCreateContact({ firstName: "Dana", email: "dana@example.com" });
    const second = await crm.findOrCreateContact({ firstName: "Alex", email: "alex@example.com" });

    await crm.bookAppointment({ slotId: slot!.id, contactId: first.id, serviceId: "intro-session" });

    await expect(
      crm.bookAppointment({ slotId: slot!.id, contactId: second.id, serviceId: "intro-session" }),
    ).rejects.toThrow(SlotTakenError);

    expect(crm.snapshot().appointments).toHaveLength(1);
  });

  it("removes a booked slot from subsequent availability", async () => {
    const before = await crm.getAvailableSlots("intro-session", WINDOW_START, WINDOW_END);
    const contact = await crm.findOrCreateContact({ firstName: "Dana", email: "dana@example.com" });
    await crm.bookAppointment({
      slotId: before[0]!.id,
      contactId: contact.id,
      serviceId: "intro-session",
    });

    const after = await crm.getAvailableSlots("intro-session", WINDOW_START, WINDOW_END);
    expect(after.map((s) => s.id)).not.toContain(before[0]!.id);
    expect(after).toHaveLength(before.length - 1);
  });
});

describe("cancellation", () => {
  it("cancels and frees the slot back up", async () => {
    const [slot] = await crm.getAvailableSlots("intro-session", WINDOW_START, WINDOW_END);
    const contact = await crm.findOrCreateContact({ firstName: "Dana", email: "dana@example.com" });
    const appointment = await crm.bookAppointment({
      slotId: slot!.id,
      contactId: contact.id,
      serviceId: "intro-session",
    });

    const cancelled = await crm.cancelAppointment(appointment.id);
    expect(cancelled.status).toBe("cancelled");

    const after = await crm.getAvailableSlots("intro-session", WINDOW_START, WINDOW_END);
    expect(after.map((s) => s.id)).toContain(slot!.id);
  });

  it("is idempotent", async () => {
    const [slot] = await crm.getAvailableSlots("intro-session", WINDOW_START, WINDOW_END);
    const contact = await crm.findOrCreateContact({ firstName: "Dana", email: "dana@example.com" });
    const appointment = await crm.bookAppointment({
      slotId: slot!.id,
      contactId: contact.id,
      serviceId: "intro-session",
    });

    await crm.cancelAppointment(appointment.id);
    const again = await crm.cancelAppointment(appointment.id);
    expect(again.status).toBe("cancelled");
  });
});

describe("appointment lookup", () => {
  it("returns only that contact's appointments", async () => {
    const slots = await crm.getAvailableSlots("intro-session", WINDOW_START, WINDOW_END);
    const dana = await crm.findOrCreateContact({ firstName: "Dana", email: "dana@example.com" });
    const alex = await crm.findOrCreateContact({ firstName: "Alex", email: "alex@example.com" });

    await crm.bookAppointment({ slotId: slots[0]!.id, contactId: dana.id, serviceId: "intro-session" });
    await crm.bookAppointment({ slotId: slots[1]!.id, contactId: alex.id, serviceId: "intro-session" });

    const danas = await crm.findAppointmentsFor(dana.id);
    expect(danas).toHaveLength(1);
    expect(danas[0]!.contactId).toBe(dana.id);
  });
});

// --- helpers ---------------------------------------------------------------

function toMinutes(clock: string): number {
  const [h, m] = clock.split(":");
  return Number(h) * 60 + Number(m);
}

function localMinutesOfDay(instant: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: business.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const hour = Number(parts.find((p) => p.type === "hour")!.value);
  const minute = Number(parts.find((p) => p.type === "minute")!.value);
  return hour * 60 + minute;
}
