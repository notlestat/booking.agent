import { createHash } from "node:crypto";
import { business, findService } from "../config/index.js";
import { log } from "../util/log.js";
import { addMinutes } from "../util/time.js";
import {
  type Appointment,
  type Contact,
  type ContactInput,
  type CrmAdapter,
  CrmUnavailableError,
  type LeadInput,
  type Slot,
  SlotTakenError,
  UnknownSlotError,
} from "./types.js";

/**
 * GoHighLevel (LeadConnector) API v2 adapter.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * STATUS: written against the published API docs, NOT yet verified against a
 * live account. Nobody has run this with a real token. Before trusting it in
 * front of a customer, run through docs/GHL-SETUP.md and check each call.
 * The mock adapter is the one that's actually exercised by the test suite.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Two things about this API that will bite you:
 *
 * 1. The `Version` header is NOT global. Calendar endpoints want 2021-04-15;
 *    contact endpoints want 2021-07-28. Sending the wrong one is a 4xx that
 *    doesn't clearly say why.
 *
 * 2. `free-slots` takes epoch **milliseconds**, not ISO strings, and returns an
 *    object keyed by local calendar date rather than a flat array. The shape has
 *    varied between accounts, so the parser below accepts both documented forms.
 */

const BASE_URL = "https://services.leadconnectorhq.com";
const CALENDAR_VERSION = "2021-04-15";
const CONTACT_VERSION = "2021-07-28";

export interface GoHighLevelOptions {
  /** Private Integration token ("pit-..."). */
  token: string;
  /** Sub-account / location ID. */
  locationId: string;
  /** Optional staff member appointments are assigned to. */
  assignedUserId?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export class GoHighLevelCrm implements CrmAdapter {
  readonly name = "gohighlevel";

  private readonly fetchImpl: typeof fetch;
  /** Slot ID -> opening, populated when we hand slots out. Same trick as the mock. */
  private readonly knownSlots = new Map<string, Slot>();

  constructor(private readonly options: GoHighLevelOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  // --- Contacts ------------------------------------------------------------

  async findOrCreateContact(input: ContactInput): Promise<Contact> {
    // `upsert` is find-or-create in one call: GHL matches on email/phone within
    // the location and returns the existing contact if there is one.
    const body: Record<string, unknown> = {
      locationId: this.options.locationId,
      firstName: input.firstName,
    };
    if (input.lastName) body.lastName = input.lastName;
    if (input.email) body.email = input.email;
    if (input.phone) body.phone = input.phone;

    const response = await this.request<{ contact?: { id?: string } }>(
      "POST",
      "/contacts/upsert",
      CONTACT_VERSION,
      { body },
    );

    const id = response.contact?.id;
    if (!id) {
      throw new CrmUnavailableError("GoHighLevel upserted a contact but returned no contact id.");
    }
    return { id, ...input };
  }

  // --- Availability --------------------------------------------------------

  async getAvailableSlots(serviceId: string, fromIso: string, toIso: string): Promise<Slot[]> {
    const service = findService(serviceId);
    if (!service) return [];
    if (!service.calendarId) {
      throw new CrmUnavailableError(
        `Service "${serviceId}" has no calendarId. Set it in the business config before ` +
          `using CRM_ADAPTER=gohighlevel — see docs/GHL-SETUP.md.`,
      );
    }

    // Respect the business's own minimum-notice rule even though GHL has its
    // own; whichever is stricter should win, and ours is the one the customer
    // was told about.
    const earliest = new Date(
      Math.max(new Date(fromIso).getTime(), Date.now() + business.booking.minNoticeHours * 3_600_000),
    );
    const latest = new Date(toIso);
    if (earliest >= latest) return [];

    const query = new URLSearchParams({
      // Epoch milliseconds, not ISO. This is the #1 thing people get wrong here.
      startDate: String(earliest.getTime()),
      endDate: String(latest.getTime()),
      timezone: business.timezone,
    });

    const payload = await this.request<Record<string, unknown>>(
      "GET",
      `/calendars/${encodeURIComponent(service.calendarId)}/free-slots?${query}`,
      CALENDAR_VERSION,
    );

    const slots: Slot[] = [];
    for (const [key, value] of Object.entries(payload)) {
      // The response mixes date keys with metadata keys like `traceId`.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;

      for (const raw of extractSlotTimes(value)) {
        const start = new Date(raw);
        if (Number.isNaN(start.getTime())) {
          log.warn("Skipping unparseable slot time from GoHighLevel", { raw, date: key });
          continue;
        }
        const slot: Slot = {
          id: slotId(serviceId, start.toISOString()),
          serviceId,
          startsAt: start.toISOString(),
          endsAt: addMinutes(start, service.durationMinutes).toISOString(),
        };
        this.knownSlots.set(slot.id, slot);
        slots.push(slot);
      }
    }

    slots.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    return slots;
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

    const service = findService(args.serviceId);
    if (!service?.calendarId) {
      throw new CrmUnavailableError(`Service "${args.serviceId}" has no calendarId configured.`);
    }

    // Re-check availability at write time. GHL will also reject a conflicting
    // booking, but doing our own check lets us return the specific, actionable
    // SlotTakenError instead of a generic 4xx.
    const stillFree = await this.getAvailableSlots(
      args.serviceId,
      slot.startsAt,
      new Date(new Date(slot.endsAt).getTime() + 60_000).toISOString(),
    );
    if (!stillFree.some((s) => s.startsAt === slot.startsAt)) {
      throw new SlotTakenError(slot.id);
    }

    const body: Record<string, unknown> = {
      calendarId: service.calendarId,
      locationId: this.options.locationId,
      contactId: args.contactId,
      startTime: slot.startsAt,
      endTime: slot.endsAt,
      title: `${service.name} — booked via chat`,
      appointmentStatus: "confirmed",
    };
    if (this.options.assignedUserId) body.assignedUserId = this.options.assignedUserId;

    const response = await this.request<{ id?: string; event?: { id?: string } }>(
      "POST",
      "/calendars/events/appointments",
      CALENDAR_VERSION,
      { body },
    );

    const id = response.id ?? response.event?.id;
    if (!id) {
      throw new CrmUnavailableError("GoHighLevel created an appointment but returned no id.");
    }

    return {
      id,
      serviceId: args.serviceId,
      contactId: args.contactId,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      status: "booked",
      ...(args.notes ? { notes: args.notes } : {}),
    };
  }

  async findAppointmentsFor(contactId: string): Promise<Appointment[]> {
    const query = new URLSearchParams({ locationId: this.options.locationId, contactId });
    const payload = await this.request<{ events?: unknown[] }>(
      "GET",
      `/contacts/${encodeURIComponent(contactId)}/appointments?${query}`,
      CONTACT_VERSION,
    );

    const events = Array.isArray(payload.events) ? payload.events : [];
    return events
      .map((event) => toAppointment(event, contactId))
      .filter((a): a is Appointment => a !== undefined)
      .sort((a, b) => b.startsAt.localeCompare(a.startsAt));
  }

  async cancelAppointment(appointmentId: string): Promise<Appointment> {
    const payload = await this.request<Record<string, unknown>>(
      "PUT",
      `/calendars/events/appointments/${encodeURIComponent(appointmentId)}`,
      CALENDAR_VERSION,
      { body: { appointmentStatus: "cancelled" } },
    );

    const cancelled = toAppointment(payload, String(payload.contactId ?? ""));
    if (cancelled) return { ...cancelled, status: "cancelled" };

    // The update succeeded but the response wasn't shaped as expected. The
    // cancellation is real; report it rather than failing the customer's request.
    return {
      id: appointmentId,
      serviceId: "",
      contactId: "",
      startsAt: new Date().toISOString(),
      endsAt: new Date().toISOString(),
      status: "cancelled",
    };
  }

  async recordLead(input: LeadInput): Promise<void> {
    const contact = await this.findOrCreateContact({
      firstName: input.firstName,
      ...(input.lastName ? { lastName: input.lastName } : {}),
      ...(input.email ? { email: input.email } : {}),
      ...(input.phone ? { phone: input.phone } : {}),
    });

    const noteBody = [`Interested in: ${input.interest}`, input.notes].filter(Boolean).join("\n");
    await this.request("POST", `/contacts/${encodeURIComponent(contact.id)}/notes`, CONTACT_VERSION, {
      body: { body: noteBody, userId: this.options.assignedUserId },
    });
  }

  // --- HTTP ----------------------------------------------------------------

  private async request<T>(
    method: string,
    path: string,
    version: string,
    init?: { body?: unknown },
  ): Promise<T> {
    const url = `${BASE_URL}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.token}`,
      Version: version,
      Accept: "application/json",
    };
    if (init?.body !== undefined) headers["Content-Type"] = "application/json";

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (cause) {
      // Network failure, DNS, timeout. The agent turns this into "I can't reach
      // our booking system, here's the phone number" — never a fake success.
      throw new CrmUnavailableError(`Could not reach GoHighLevel (${method} ${path}).`, cause);
    }

    const text = await response.text();

    if (!response.ok) {
      log.error("GoHighLevel request failed", {
        method,
        path,
        status: response.status,
        body: text.slice(0, 500),
      });
      throw new CrmUnavailableError(
        `GoHighLevel returned ${response.status} for ${method} ${path}: ${text.slice(0, 200)}`,
      );
    }

    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new CrmUnavailableError(`GoHighLevel returned non-JSON for ${method} ${path}.`, cause);
    }
  }
}

/**
 * Pull slot start times out of one day's entry.
 *
 * Documented as `{ "2026-06-05": { "slots": [...] } }`, but some accounts report
 * a bare array. Accept both rather than failing on a shape difference.
 */
function extractSlotTimes(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (value && typeof value === "object" && "slots" in value) {
    const slots = (value as { slots?: unknown }).slots;
    if (Array.isArray(slots)) return slots.filter((v): v is string => typeof v === "string");
  }
  return [];
}

function toAppointment(raw: unknown, fallbackContactId: string): Appointment | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const event = raw as Record<string, unknown>;

  const id = typeof event.id === "string" ? event.id : undefined;
  const startTime = typeof event.startTime === "string" ? event.startTime : undefined;
  if (!id || !startTime) return undefined;

  const start = new Date(startTime);
  if (Number.isNaN(start.getTime())) return undefined;

  const endTime = typeof event.endTime === "string" ? new Date(event.endTime) : undefined;
  const status = String(event.appointmentStatus ?? "").toLowerCase();

  return {
    id,
    // GHL has no concept of our service IDs; the calendar it lives on is the
    // closest equivalent, and only the mock needs this for slot recomputation.
    serviceId: typeof event.calendarId === "string" ? event.calendarId : "",
    contactId: typeof event.contactId === "string" ? event.contactId : fallbackContactId,
    startsAt: start.toISOString(),
    endsAt: (endTime && !Number.isNaN(endTime.getTime()) ? endTime : start).toISOString(),
    status: status === "cancelled" ? "cancelled" : "booked",
  };
}

function slotId(serviceId: string, startsAtIso: string): string {
  const digest = createHash("sha256").update(`${serviceId}|${startsAtIso}`).digest("hex");
  return `slot_${digest.slice(0, 16)}`;
}
