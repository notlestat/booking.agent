/**
 * The CRM port.
 *
 * This interface is deliberately written in *our* vocabulary, not GoHighLevel's.
 * Nothing above this layer knows what a "location ID" is, or that free slots
 * come back keyed by date, or that GHL wants epoch milliseconds. Those are
 * details of one adapter.
 *
 * The payoff: the mock adapter and the GoHighLevel adapter are interchangeable,
 * the whole booking flow is testable with no network, and a client on a
 * different CRM is a third file rather than a rewrite.
 */

export interface Contact {
  id: string;
  firstName: string;
  lastName?: string;
  email?: string;
  phone?: string;
}

export interface ContactInput {
  firstName: string;
  lastName?: string;
  email?: string;
  phone?: string;
}

/**
 * A bookable opening.
 *
 * `id` is opaque and server-issued. This matters: the booking tool accepts a
 * slot ID and nothing else, so the model can only book times the system
 * actually offered it. See `src/agent/tools.ts`.
 */
export interface Slot {
  id: string;
  serviceId: string;
  /** UTC ISO 8601. Always UTC — see src/util/time.ts. */
  startsAt: string;
  /** UTC ISO 8601. */
  endsAt: string;
}

export interface Appointment {
  id: string;
  serviceId: string;
  contactId: string;
  /** UTC ISO 8601. */
  startsAt: string;
  /** UTC ISO 8601. */
  endsAt: string;
  status: "booked" | "cancelled";
  notes?: string;
}

export interface LeadInput {
  firstName: string;
  lastName?: string;
  email?: string;
  phone?: string;
  /** What they were interested in — free text, goes on the CRM record. */
  interest: string;
  /** Anything else worth passing to a human. */
  notes?: string;
}

/**
 * Raised when a slot was taken between being offered and being booked.
 *
 * This is the double-booking guard. It is a *typed error from the write path*,
 * not an instruction in a prompt: two customers racing for the same 2pm slot
 * cannot both win, regardless of what the model believes.
 */
export class SlotTakenError extends Error {
  constructor(public readonly slotId: string) {
    super(`Slot ${slotId} is no longer available.`);
    this.name = "SlotTakenError";
  }
}

/** Raised when a slot ID doesn't correspond to a real opening. */
export class UnknownSlotError extends Error {
  constructor(public readonly slotId: string) {
    super(`Slot ${slotId} does not exist.`);
    this.name = "UnknownSlotError";
  }
}

/** Raised when the CRM is unreachable or returns an error we can't act on. */
export class CrmUnavailableError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = "CrmUnavailableError";
  }
}

export interface CrmAdapter {
  /** Human-readable adapter name, for logs and the debug endpoint. */
  readonly name: string;

  /**
   * Find an existing contact by email or phone, or create one.
   * Idempotent: calling twice with the same email returns the same contact.
   */
  findOrCreateContact(input: ContactInput): Promise<Contact>;

  /**
   * Bookable openings for a service within a UTC window.
   * Returns them in chronological order. May return an empty array.
   */
  getAvailableSlots(serviceId: string, fromIso: string, toIso: string): Promise<Slot[]>;

  /**
   * Book a previously-offered slot.
   * @throws {UnknownSlotError} if the slot ID isn't real
   * @throws {SlotTakenError} if someone else booked it first
   */
  bookAppointment(args: {
    slotId: string;
    contactId: string;
    serviceId: string;
    notes?: string;
  }): Promise<Appointment>;

  /** Every appointment for a contact, newest first. Includes cancelled ones. */
  findAppointmentsFor(contactId: string): Promise<Appointment[]>;

  /** Cancel a booking. Idempotent: cancelling twice is not an error. */
  cancelAppointment(appointmentId: string): Promise<Appointment>;

  /** Record an interested person who didn't book. */
  recordLead(input: LeadInput): Promise<void>;
}
