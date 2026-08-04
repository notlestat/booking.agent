import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { business, findService, serviceIds } from "../config/index.js";
import {
  type CrmAdapter,
  CrmUnavailableError,
  SlotTakenError,
  type Slot,
  UnknownSlotError,
} from "../crm/types.js";
import { log } from "../util/log.js";
import {
  addDaysToDayKey,
  dayKeyInZone,
  formatDateForHumans,
  formatSlotForHumans,
  formatTimeForHumans,
  parseDayKey,
  wallClockToUtc,
} from "../util/time.js";
import { rememberOfferedSlots, type Session } from "./session.js";

/**
 * The agent's tools.
 *
 * This file is the security boundary of the whole application. The model cannot
 * touch the CRM directly — it can only call these functions, with arguments that
 * Zod has already validated. Every rule that must actually hold is enforced
 * here, in TypeScript, not asked for in the system prompt:
 *
 *   - "Don't invent appointment times"  -> book_appointment takes a slot ID and
 *                                          rejects any ID this session wasn't shown.
 *   - "Don't double-book"               -> the CRM re-checks at write time and
 *                                          throws SlotTakenError.
 *   - "Don't claim a booking that failed"-> a failed write returns an error string;
 *                                          there is no code path that reports
 *                                          success without a resolved promise.
 *
 * Tool results are plain English because the model reads them. A result of
 * `{"ok":false,"code":"E_SLOT"}` produces vague, confused replies; "That 2pm
 * slot was just taken. Still open that day: 3pm, 4:30pm." produces a good one.
 */

export function buildTools(session: Session, crm: CrmAdapter) {
  return [
    checkAvailability(session, crm),
    bookAppointment(session, crm),
    lookUpBooking(session, crm),
    cancelAppointment(session, crm),
    saveLead(crm),
    escalateToHuman(),
  ];
}

// --- check_availability ------------------------------------------------------

function checkAvailability(session: Session, crm: CrmAdapter) {
  return betaZodTool({
    name: "check_availability",
    description: [
      "Find open appointment times for a service. You MUST call this before mentioning",
      "any specific time to the customer — you have no other way to know the gym's",
      "calendar, and times you state without calling this will be wrong.",
      "",
      "Returns a short list of openings, each with a slot_id. To book one, pass its",
      "slot_id to book_appointment. Slot IDs are the only way to book.",
      "",
      "If the customer was vague about timing ('sometime next week'), call this with a",
      "wide window and offer them a couple of options rather than asking them to narrow",
      "it down first.",
    ].join("\n"),
    inputSchema: z.object({
      service_id: z
        .string()
        .describe(`Which service. One of: ${serviceIds().join(", ")}`),
      from_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe("First date to search, YYYY-MM-DD, in the gym's local timezone."),
      to_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe(
          "Last date to search, YYYY-MM-DD, inclusive. Use a range of several days unless the customer named one specific day.",
        ),
      time_of_day: z
        .enum(["any", "morning", "afternoon", "evening"])
        .optional()
        .describe(
          "Filter to part of the day if the customer expressed a preference. Morning is before noon, afternoon is noon-5pm, evening is 5pm onward.",
        ),
    }),
    run: async (input) => {
      const service = findService(input.service_id);
      if (!service) {
        return `There's no service with id "${input.service_id}". Valid ids: ${serviceIds().join(", ")}.`;
      }

      let fromUtc: Date;
      let toUtc: Date;
      try {
        const from = parseDayKey(input.from_date);
        // Search to the END of to_date, hence the +1 day at midnight.
        const to = parseDayKey(addDaysToDayKey(input.to_date, 1));
        fromUtc = wallClockToUtc(from.year, from.month, from.day, 0, 0, business.timezone);
        toUtc = wallClockToUtc(to.year, to.month, to.day, 0, 0, business.timezone);
      } catch (error) {
        return `Those dates didn't parse: ${(error as Error).message}`;
      }

      if (fromUtc >= toUtc) {
        return `The date range is backwards — from_date (${input.from_date}) must not be after to_date (${input.to_date}).`;
      }

      let slots: Slot[];
      try {
        slots = await crm.getAvailableSlots(input.service_id, fromUtc.toISOString(), toUtc.toISOString());
      } catch (error) {
        return crmFailureMessage(error, "look up availability");
      }

      const filtered = filterByTimeOfDay(slots, input.time_of_day ?? "any");

      if (filtered.length === 0) {
        const reason =
          slots.length > 0
            ? `There's nothing ${input.time_of_day} in that range, though there are other times open.`
            : `Nothing is open for ${service.name} between ${input.from_date} and ${input.to_date}.`;
        return `${reason} Try a wider date range, or ask the customer about a different day.`;
      }

      // Cap what we hand back. The model doesn't need 200 options to offer two,
      // and a huge tool result is tokens spent to make the reply worse.
      const shown = filtered.slice(0, 12);
      rememberOfferedSlots(session, shown);

      log.info("Availability checked", {
        sessionId: session.id,
        serviceId: input.service_id,
        found: filtered.length,
        returned: shown.length,
      });

      return [
        `${shown.length} opening${shown.length === 1 ? "" : "s"} for ${service.name} (${service.durationMinutes} min).`,
        filtered.length > shown.length
          ? `Showing the first ${shown.length} of ${filtered.length}.`
          : "",
        "",
        ...groupByDay(shown),
        "",
        "Offer the customer two or three of these in a sentence. To book, call",
        "book_appointment with the slot_id shown in brackets.",
      ]
        .filter(Boolean)
        .join("\n");
    },
  });
}

function filterByTimeOfDay(slots: Slot[], preference: "any" | "morning" | "afternoon" | "evening"): Slot[] {
  if (preference === "any") return slots;
  return slots.filter((slot) => {
    const hour = localHour(new Date(slot.startsAt));
    if (preference === "morning") return hour < 12;
    if (preference === "afternoon") return hour >= 12 && hour < 17;
    return hour >= 17;
  });
}

function localHour(instant: Date): number {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: business.timezone,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(instant),
  );
}

/** "Thursday, June 5: 9:00 AM [slot_ab12…], 10:30 AM [slot_cd34…]" */
function groupByDay(slots: Slot[]): string[] {
  const byDay = new Map<string, Slot[]>();
  for (const slot of slots) {
    const key = dayKeyInZone(new Date(slot.startsAt), business.timezone);
    const bucket = byDay.get(key);
    if (bucket) bucket.push(slot);
    else byDay.set(key, [slot]);
  }

  return [...byDay.entries()].map(([, daySlots]) => {
    const first = daySlots[0];
    if (!first) return "";
    const heading = formatDateForHumans(new Date(first.startsAt), business.timezone);
    const times = daySlots
      .map((s) => `${formatTimeForHumans(new Date(s.startsAt), business.timezone)} [${s.id}]`)
      .join(", ");
    return `${heading}: ${times}`;
  });
}

// --- book_appointment --------------------------------------------------------

function bookAppointment(session: Session, crm: CrmAdapter) {
  return betaZodTool({
    name: "book_appointment",
    description: [
      "Book one of the openings that check_availability returned.",
      "",
      "There is deliberately no way to pass a date or time here. You can only book a",
      "slot_id that check_availability gave you in this conversation. If the customer",
      "wants a time you don't have a slot_id for, call check_availability again for",
      "that window — do not guess an ID.",
      "",
      "Collect the customer's first name and at least one of email or phone before",
      "calling this. Only tell the customer they're booked if this call succeeds.",
    ].join("\n"),
    inputSchema: z.object({
      slot_id: z
        .string()
        .describe("The slot_id from check_availability, exactly as shown in brackets."),
      first_name: z.string().min(1).describe("Customer's first name."),
      last_name: z.string().optional().describe("Customer's last name, if they gave one."),
      email: z.string().email().optional().describe("Customer's email address."),
      phone: z.string().optional().describe("Customer's phone number."),
      notes: z
        .string()
        .optional()
        .describe("Anything the coach should know — goals, injuries, first-timer, etc."),
    }),
    run: async (input) => {
      // GUARD 1: the slot must be one this session was actually shown.
      // This is what stops a hallucinated or fabricated time from being booked.
      const slot = session.offeredSlots.get(input.slot_id);
      if (!slot) {
        log.warn("Rejected booking for an un-offered slot", {
          sessionId: session.id,
          slotId: input.slot_id,
        });
        return [
          `"${input.slot_id}" isn't a slot that was offered in this conversation, so it can't be booked.`,
          "This usually means the time was guessed rather than taken from check_availability.",
          "Call check_availability for the window the customer wants and offer them a real opening.",
        ].join(" ");
      }

      if (!input.email && !input.phone) {
        return "Need at least an email address or a phone number before booking. Ask the customer for one.";
      }

      const service = findService(slot.serviceId);
      const when = formatSlotForHumans(new Date(slot.startsAt), business.timezone);

      try {
        const contact = await crm.findOrCreateContact({
          firstName: input.first_name,
          ...(input.last_name ? { lastName: input.last_name } : {}),
          ...(input.email ? { email: input.email } : {}),
          ...(input.phone ? { phone: input.phone } : {}),
        });
        session.contactId = contact.id;

        // GUARD 2: the CRM re-checks availability at write time. Being free when
        // it was offered says nothing about being free now.
        const appointment = await crm.bookAppointment({
          slotId: slot.id,
          contactId: contact.id,
          serviceId: slot.serviceId,
          ...(input.notes ? { notes: input.notes } : {}),
        });

        session.bookedAppointmentIds.push(appointment.id);
        session.offeredSlots.delete(slot.id);

        log.info("Appointment booked", {
          sessionId: session.id,
          appointmentId: appointment.id,
          serviceId: slot.serviceId,
        });

        return [
          `Booked. ${service?.name ?? "Appointment"} on ${when}, ${service?.durationMinutes ?? 0} minutes.`,
          `Confirmation reference ${appointment.id}.`,
          "",
          `Tell the customer it's confirmed, restate the day and time, and mention: ${business.policies.firstVisit}`,
        ].join("\n");
      } catch (error) {
        if (error instanceof SlotTakenError) {
          log.info("Booking lost a race for a slot", { sessionId: session.id, slotId: slot.id });
          return [
            `That ${when} slot was taken by someone else before the booking went through.`,
            "Nothing was booked. Apologise briefly, call check_availability again for that day,",
            "and offer what's actually still open.",
          ].join(" ");
        }
        if (error instanceof UnknownSlotError) {
          return "That slot is no longer recognised by the booking system. Call check_availability again and offer a current opening.";
        }
        return crmFailureMessage(error, "book the appointment");
      }
    },
  });
}

// --- look_up_booking ---------------------------------------------------------

function lookUpBooking(session: Session, crm: CrmAdapter) {
  return betaZodTool({
    name: "look_up_booking",
    description: [
      "Find a customer's existing appointments by email or phone. Use this when",
      "someone asks about, wants to change, or wants to cancel a booking.",
      "Returns appointment IDs needed by cancel_appointment.",
    ].join(" "),
    inputSchema: z.object({
      email: z.string().email().optional().describe("The email they booked with."),
      phone: z.string().optional().describe("The phone number they booked with."),
    }),
    run: async (input) => {
      if (!input.email && !input.phone) {
        return "Need an email or phone number to look up a booking. Ask the customer which they used.";
      }

      try {
        // findOrCreateContact is safe here: if they've booked before we get the
        // existing record; if not, we get an empty one and correctly report
        // "no appointments" rather than a confusing error.
        const contact = await crm.findOrCreateContact({
          firstName: "",
          ...(input.email ? { email: input.email } : {}),
          ...(input.phone ? { phone: input.phone } : {}),
        });
        session.contactId = contact.id;

        const appointments = await crm.findAppointmentsFor(contact.id);
        const active = appointments.filter((a) => a.status === "booked");

        if (active.length === 0) {
          return "No upcoming appointments found for those details. Check whether they used a different email or phone, or offer to book something new.";
        }

        const lines = active.map((appointment) => {
          const service = findService(appointment.serviceId);
          const when = formatSlotForHumans(new Date(appointment.startsAt), business.timezone);
          return `- ${service?.name ?? "Appointment"} on ${when} (appointment_id: ${appointment.id})`;
        });

        return [`${active.length} upcoming appointment(s):`, ...lines].join("\n");
      } catch (error) {
        return crmFailureMessage(error, "look up the booking");
      }
    },
  });
}

// --- cancel_appointment ------------------------------------------------------

function cancelAppointment(session: Session, crm: CrmAdapter) {
  return betaZodTool({
    name: "cancel_appointment",
    description: [
      "Cancel an existing appointment. Call look_up_booking first to get the",
      "appointment_id — never guess one. Confirm with the customer that they want it",
      "cancelled before calling this.",
    ].join(" "),
    inputSchema: z.object({
      appointment_id: z.string().describe("From look_up_booking."),
    }),
    run: async (input) => {
      // Only appointments belonging to the contact we've identified this session
      // can be cancelled — otherwise a guessed ID could cancel a stranger's slot.
      if (!session.contactId) {
        return "No customer has been identified in this conversation yet. Call look_up_booking with their email or phone first.";
      }

      try {
        const owned = await crm.findAppointmentsFor(session.contactId);
        const match = owned.find((a) => a.id === input.appointment_id);
        if (!match) {
          return `Appointment ${input.appointment_id} doesn't belong to this customer. Call look_up_booking and use an ID from those results.`;
        }
        if (match.status === "cancelled") {
          return "That appointment was already cancelled. Let the customer know, and offer to book a new time.";
        }

        await crm.cancelAppointment(input.appointment_id);
        log.info("Appointment cancelled", {
          sessionId: session.id,
          appointmentId: input.appointment_id,
        });

        const when = formatSlotForHumans(new Date(match.startsAt), business.timezone);
        return `Cancelled the ${when} appointment. Confirm to the customer, and offer to rebook if they'd like.`;
      } catch (error) {
        return crmFailureMessage(error, "cancel the appointment");
      }
    },
  });
}

// --- save_lead ---------------------------------------------------------------

function saveLead(crm: CrmAdapter) {
  return betaZodTool({
    name: "save_lead",
    description: [
      "Record someone who's interested but isn't booking right now, so staff can",
      "follow up. Ask their permission before calling this — don't collect contact",
      "details silently.",
    ].join(" "),
    inputSchema: z.object({
      first_name: z.string().min(1),
      last_name: z.string().optional(),
      email: z.string().email().optional(),
      phone: z.string().optional(),
      interest: z.string().describe("What they were asking about, in a few words."),
      notes: z.string().optional().describe("Anything else useful for the follow-up."),
    }),
    run: async (input) => {
      if (!input.email && !input.phone) {
        return "Need an email or phone number to save a lead — otherwise nobody can follow up. Ask for one.";
      }
      try {
        await crm.recordLead({
          firstName: input.first_name,
          ...(input.last_name ? { lastName: input.last_name } : {}),
          ...(input.email ? { email: input.email } : {}),
          ...(input.phone ? { phone: input.phone } : {}),
          interest: input.interest,
          ...(input.notes ? { notes: input.notes } : {}),
        });
        return "Saved. Tell the customer someone will be in touch, and roughly when.";
      } catch (error) {
        return crmFailureMessage(error, "save their details");
      }
    },
  });
}

// --- escalate_to_human -------------------------------------------------------

function escalateToHuman() {
  return betaZodTool({
    name: "escalate_to_human",
    description: [
      "Flag that this conversation needs a person. Use it for billing disputes,",
      "cancellations of membership, injuries or medical questions, complaints, and",
      "anything where you'd otherwise be guessing at an answer.",
    ].join(" "),
    inputSchema: z.object({
      reason: z.string().describe("Why this needs a human, in one line."),
      summary: z.string().describe("What the customer wants, so staff don't ask them to repeat it."),
    }),
    run: async (input) => {
      log.info("Escalated to human", { reason: input.reason, summary: input.summary });
      return [
        "Logged for staff follow-up.",
        `Tell the customer honestly that this needs a person, and: ${business.escalation.contactMethod}`,
      ].join(" ");
    },
  });
}

// --- shared ------------------------------------------------------------------

/**
 * What the model sees when the CRM is down.
 *
 * Deliberately explicit that nothing was saved. The failure mode we're
 * preventing is an agent that hits an error and cheerfully says "you're all
 * booked!" — so the tool result spells out that no booking exists.
 */
function crmFailureMessage(error: unknown, attemptedAction: string): string {
  const detail = error instanceof CrmUnavailableError ? error.message : String(error);
  log.error(`CRM failure while trying to ${attemptedAction}`, { detail });
  return [
    `Could not ${attemptedAction} — the booking system isn't responding.`,
    "Nothing was saved or changed.",
    `Tell the customer plainly that the system is having trouble and give them the gym's number: ${business.phone}.`,
    "Do not claim anything was booked.",
  ].join(" ");
}
