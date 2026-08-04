import { createHash } from "node:crypto";
import { business, findService } from "../config/index.js";
import {
  addDaysToDayKey,
  addMinutes,
  dayKeyInZone,
  parseClockTime,
  parseDayKey,
  wallClockToUtc,
  weekdayInZone,
} from "../util/time.js";
import {
  type Appointment,
  type Contact,
  type ContactInput,
  type CrmAdapter,
  type LeadInput,
  type Slot,
  SlotTakenError,
  UnknownSlotError,
} from "./types.js";

/**
 * An in-memory CRM.
 *
 * This exists so the entire booking flow runs, and is tested, with no external
 * accounts and no network. It is not a stub that returns canned data — it
 * generates availability from the business's real opening hours, enforces
 * minimum notice, and refuses to double-book. If the flow works here, the only
 * thing the GoHighLevel adapter has to get right is talking to GoHighLevel.
 *
 * State lives in Maps and dies with the process. That's the point: every demo
 * starts from a clean, deterministic gym.
 */
export class MockCrm implements CrmAdapter {
  readonly name = "mock";

  private readonly contacts = new Map<string, Contact>();
  private readonly appointments = new Map<string, Appointment>();
  private readonly leads: LeadInput[] = [];

  /** Slot ID -> the opening it refers to. Populated as slots are generated. */
  private readonly knownSlots = new Map<string, Slot>();

  /** Slot IDs that are taken. Seeded busy times plus anything booked this session. */
  private readonly takenSlots = new Set<string>();

  private counter = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  // --- Contacts ------------------------------------------------------------

  async findOrCreateContact(input: ContactInput): Promise<Contact> {
    const existing = this.matchContact(input);
    if (existing) {
      // Fill in anything we learned since last time (they gave a phone this
      // visit but only an email last visit).
      const merged: Contact = {
        ...existing,
        firstName: input.firstName || existing.firstName,
        lastName: input.lastName ?? existing.lastName,
        email: input.email ?? existing.email,
        phone: input.phone ?? existing.phone,
      };
      this.contacts.set(merged.id, merged);
      return merged;
    }

    const contact: Contact = { id: this.nextId("contact"), ...input };
    this.contacts.set(contact.id, contact);
    return contact;
  }

  private matchContact(input: ContactInput): Contact | undefined {
    const email = input.email?.trim().toLowerCase();
    const phone = normalisePhone(input.phone);
    for (const contact of this.contacts.values()) {
      if (email && contact.email?.trim().toLowerCase() === email) return contact;
      if (phone && normalisePhone(contact.phone) === phone) return contact;
    }
    return undefined;
  }

  // --- Availability --------------------------------------------------------

  async getAvailableSlots(serviceId: string, fromIso: string, toIso: string): Promise<Slot[]> {
    const service = findService(serviceId);
    if (!service) return [];

    const tz = business.timezone;
    const now = this.now();

    // Two floors on how soon we'll offer something: the caller's window, and
    // the business's minimum notice. Whichever is later wins.
    const earliest = new Date(
      Math.max(new Date(fromIso).getTime(), now.getTime() + business.booking.minNoticeHours * 3_600_000),
    );
    const latest = new Date(
      Math.min(new Date(toIso).getTime(), now.getTime() + business.booking.maxAdvanceDays * 86_400_000),
    );
    if (earliest >= latest) return [];

    const slots: Slot[] = [];
    const lastDayKey = dayKeyInZone(latest, tz);

    // Walk calendar days in the business's own timezone, not UTC days — a gym
    // in Portland closes at 9pm local, which is 1am the *next* UTC day.
    let dayKey = dayKeyInZone(earliest, tz);
    for (let guard = 0; guard <= business.booking.maxAdvanceDays + 1; guard++) {
      const { year, month, day } = parseDayKey(dayKey);

      // Which weekday is this, locally? Noon avoids any DST edge at midnight.
      const noon = wallClockToUtc(year, month, day, 12, 0, tz);
      const weekday = weekdayInZone(noon, tz);
      const ranges = business.hours[weekday] ?? [];

      for (const range of ranges) {
        const open = parseClockTime(range.open);
        const close = parseClockTime(range.close);
        const opensAt = wallClockToUtc(year, month, day, open.hour, open.minute, tz);
        const closesAt = wallClockToUtc(year, month, day, close.hour, close.minute, tz);

        for (
          let start = opensAt;
          // The whole appointment has to finish before closing time.
          addMinutes(start, service.durationMinutes) <= closesAt;
          start = addMinutes(start, business.booking.slotIntervalMinutes)
        ) {
          if (start < earliest || start > latest) continue;

          const startsAt = start.toISOString();
          const slot: Slot = {
            id: slotId(serviceId, startsAt),
            serviceId,
            startsAt,
            endsAt: addMinutes(start, service.durationMinutes).toISOString(),
          };

          this.knownSlots.set(slot.id, slot);
          if (this.takenSlots.has(slot.id)) continue;
          if (this.isSeededBusy(slot)) continue;

          slots.push(slot);
        }
      }

      if (dayKey === lastDayKey) break;
      dayKey = addDaysToDayKey(dayKey, 1);
    }

    slots.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    return slots;
  }

  /**
   * Pretend some of the gym's calendar is already booked.
   *
   * Deterministic (hash-derived, not random) so tests are stable and a demo
   * shows the same gaps every run. Without this every slot is free, which looks
   * fake and never exercises "that time's taken, how about these?".
   */
  private isSeededBusy(slot: Slot): boolean {
    const bucket = hashToInt(`busy:${slot.serviceId}:${slot.startsAt}`) % 100;
    return bucket < 40;
  }

  // --- Booking -------------------------------------------------------------

  async bookAppointment(args: {
    slotId: string;
    contactId: string;
    serviceId: string;
    notes?: string;
  }): Promise<Appointment> {
    const slot = this.knownSlots.get(args.slotId);
    if (!slot) throw new UnknownSlotError(args.slotId);

    // Re-check at write time, not just at read time. The slot was free when we
    // offered it; that says nothing about whether it's free now.
    if (this.takenSlots.has(slot.id) || this.isSeededBusy(slot)) {
      throw new SlotTakenError(slot.id);
    }

    this.takenSlots.add(slot.id);

    const appointment: Appointment = {
      id: this.nextId("appt"),
      serviceId: args.serviceId,
      contactId: args.contactId,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      status: "booked",
      ...(args.notes ? { notes: args.notes } : {}),
    };
    this.appointments.set(appointment.id, appointment);
    return appointment;
  }

  async findAppointmentsFor(contactId: string): Promise<Appointment[]> {
    return [...this.appointments.values()]
      .filter((a) => a.contactId === contactId)
      .sort((a, b) => b.startsAt.localeCompare(a.startsAt));
  }

  async cancelAppointment(appointmentId: string): Promise<Appointment> {
    const appointment = this.appointments.get(appointmentId);
    if (!appointment) throw new Error(`No appointment with id ${appointmentId}`);

    if (appointment.status === "cancelled") return appointment;

    const cancelled: Appointment = { ...appointment, status: "cancelled" };
    this.appointments.set(cancelled.id, cancelled);

    // Put the slot back on the market.
    this.takenSlots.delete(slotId(appointment.serviceId, appointment.startsAt));
    return cancelled;
  }

  async recordLead(input: LeadInput): Promise<void> {
    this.leads.push(input);
  }

  // --- Inspection (used by the dev-only debug route and by tests) -----------

  snapshot(): { contacts: Contact[]; appointments: Appointment[]; leads: LeadInput[] } {
    return {
      contacts: [...this.contacts.values()],
      appointments: [...this.appointments.values()],
      leads: [...this.leads],
    };
  }

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${this.counter.toString().padStart(4, "0")}`;
  }
}

/**
 * A stable, opaque ID for an opening.
 *
 * Stable so that asking for availability twice yields the same IDs. Opaque
 * (hashed rather than "serviceId@timestamp") so a fabricated ID is
 * overwhelmingly likely to be rejected rather than to accidentally resolve to a
 * real slot.
 */
function slotId(serviceId: string, startsAtIso: string): string {
  return `slot_${hashHex(`${serviceId}|${startsAtIso}`).slice(0, 16)}`;
}

function hashHex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashToInt(value: string): number {
  return parseInt(hashHex(value).slice(0, 8), 16);
}

function normalisePhone(phone?: string): string | undefined {
  if (!phone) return undefined;
  const digits = phone.replace(/\D/g, "");
  return digits.length > 0 ? digits.slice(-10) : undefined;
}
