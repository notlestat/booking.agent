import { beforeEach, describe, expect, it } from "vitest";
import { clearSessions, createSession, type Session } from "../src/agent/session.js";
import { buildTools } from "../src/agent/tools.js";
import { MockCrm } from "../src/crm/mock.js";
import { CrmUnavailableError, type CrmAdapter } from "../src/crm/types.js";

/**
 * These test the trust boundary.
 *
 * The tools are the only way the model can affect anything. Every guarantee the
 * product makes — can't invent a time, can't double-book, can't claim a booking
 * that failed — has to hold here, in code, regardless of what the model decides
 * to do. So these tests bypass the model entirely and attack the tools directly,
 * the way a misbehaving model would.
 */

const NOW = new Date("2026-06-01T09:00:00.000Z");

let crm: MockCrm;
let session: Session;
let tools: ReturnType<typeof buildTools>;

function tool(name: string) {
  const found = tools.find((t) => "name" in t && t.name === name);
  if (!found) throw new Error(`No tool named ${name}`);
  return found as typeof found & { run: (args: unknown) => Promise<string> };
}

beforeEach(() => {
  clearSessions();
  crm = new MockCrm(() => NOW);
  session = createSession();
  tools = buildTools(session, crm);
});

describe("check_availability", () => {
  it("returns openings with slot ids", async () => {
    const result = await tool("check_availability").run({
      service_id: "intro-session",
      from_date: "2026-06-02",
      to_date: "2026-06-04",
    });
    expect(result).toMatch(/opening/i);
    expect(result).toMatch(/\[slot_[0-9a-f]{16}\]/);
  });

  it("records what it offered on the session", async () => {
    expect(session.offeredSlots.size).toBe(0);
    await tool("check_availability").run({
      service_id: "intro-session",
      from_date: "2026-06-02",
      to_date: "2026-06-04",
    });
    expect(session.offeredSlots.size).toBeGreaterThan(0);
  });

  it("explains itself when the service id is wrong instead of failing silently", async () => {
    const result = await tool("check_availability").run({
      service_id: "hot-yoga",
      from_date: "2026-06-02",
      to_date: "2026-06-04",
    });
    expect(result).toMatch(/no service with id/i);
    expect(result).toMatch(/intro-session/); // tells the model the valid options
  });

  it("catches a backwards date range", async () => {
    const result = await tool("check_availability").run({
      service_id: "intro-session",
      from_date: "2026-06-10",
      to_date: "2026-06-02",
    });
    expect(result).toMatch(/backwards/i);
  });

  it("filters to a requested time of day", async () => {
    const morning = await tool("check_availability").run({
      service_id: "intro-session",
      from_date: "2026-06-02",
      to_date: "2026-06-04",
      time_of_day: "morning",
    });
    // No PM times should appear in a morning-only result.
    expect(morning).not.toMatch(/\b(1[2-9]|[1-9]):\d\d PM/);
  });

  it("includes the end date in the search window", async () => {
    // An off-by-one here silently loses a whole day of availability.
    const result = await tool("check_availability").run({
      service_id: "intro-session",
      from_date: "2026-06-04",
      to_date: "2026-06-04",
    });
    expect(result).toMatch(/June 4/);
  });
});

describe("book_appointment — the anti-hallucination guard", () => {
  it("refuses a slot id that was never offered in this session", async () => {
    // A real, bookable slot — but obtained behind the tool's back, exactly as a
    // model inventing an ID would present it.
    const slots = await crm.getAvailableSlots(
      "intro-session",
      "2026-06-02T00:00:00.000Z",
      "2026-06-05T00:00:00.000Z",
    );
    expect(slots.length).toBeGreaterThan(0);

    const result = await tool("book_appointment").run({
      slot_id: slots[0]!.id,
      first_name: "Dana",
      email: "dana@example.com",
    });

    expect(result).toMatch(/isn't a slot that was offered/i);
    expect(result).toMatch(/check_availability/);
    expect(crm.snapshot().appointments).toHaveLength(0);
  });

  it("refuses an entirely made-up slot id", async () => {
    const result = await tool("book_appointment").run({
      slot_id: "slot_1111111111111111",
      first_name: "Dana",
      email: "dana@example.com",
    });
    expect(result).toMatch(/isn't a slot that was offered/i);
    expect(crm.snapshot().appointments).toHaveLength(0);
  });

  it("books a slot that was offered", async () => {
    await tool("check_availability").run({
      service_id: "intro-session",
      from_date: "2026-06-02",
      to_date: "2026-06-04",
    });
    const slotId = [...session.offeredSlots.keys()][0]!;

    const result = await tool("book_appointment").run({
      slot_id: slotId,
      first_name: "Dana",
      email: "dana@example.com",
    });

    expect(result).toMatch(/^Booked\./);
    expect(crm.snapshot().appointments).toHaveLength(1);
    expect(session.bookedAppointmentIds).toHaveLength(1);
  });

  it("requires a contact method", async () => {
    await tool("check_availability").run({
      service_id: "intro-session",
      from_date: "2026-06-02",
      to_date: "2026-06-04",
    });
    const slotId = [...session.offeredSlots.keys()][0]!;

    const result = await tool("book_appointment").run({ slot_id: slotId, first_name: "Dana" });
    expect(result).toMatch(/email address or a phone number/i);
    expect(crm.snapshot().appointments).toHaveLength(0);
  });

  it("reports the loss honestly when someone else takes the slot first", async () => {
    await tool("check_availability").run({
      service_id: "intro-session",
      from_date: "2026-06-02",
      to_date: "2026-06-04",
    });
    const slotId = [...session.offeredSlots.keys()][0]!;

    // Someone else books it in the gap between us offering and us writing.
    const rival = await crm.findOrCreateContact({ firstName: "Alex", email: "alex@example.com" });
    await crm.bookAppointment({ slotId, contactId: rival.id, serviceId: "intro-session" });

    const result = await tool("book_appointment").run({
      slot_id: slotId,
      first_name: "Dana",
      email: "dana@example.com",
    });

    expect(result).toMatch(/taken by someone else/i);
    expect(result).toMatch(/Nothing was booked/);
    expect(crm.snapshot().appointments).toHaveLength(1); // still just the rival's
  });

  it("does not let the same slot be booked twice through the tool", async () => {
    await tool("check_availability").run({
      service_id: "intro-session",
      from_date: "2026-06-02",
      to_date: "2026-06-04",
    });
    const slotId = [...session.offeredSlots.keys()][0]!;

    const first = await tool("book_appointment").run({
      slot_id: slotId,
      first_name: "Dana",
      email: "dana@example.com",
    });
    const second = await tool("book_appointment").run({
      slot_id: slotId,
      first_name: "Alex",
      email: "alex@example.com",
    });

    expect(first).toMatch(/^Booked\./);
    // Booking consumes the offer, so the retry is rejected at the session guard.
    expect(second).not.toMatch(/^Booked\./);
    expect(crm.snapshot().appointments).toHaveLength(1);
  });
});

describe("book_appointment — failure honesty", () => {
  it("never reports success when the CRM is down", async () => {
    // First, offer a real slot so we get past the session guard.
    await tool("check_availability").run({
      service_id: "intro-session",
      from_date: "2026-06-02",
      to_date: "2026-06-04",
    });
    const slotId = [...session.offeredSlots.keys()][0]!;

    // Now swap in a CRM that fails on write, and rebuild the tools against it.
    const brokenCrm: CrmAdapter = {
      ...crm,
      name: "broken",
      findOrCreateContact: crm.findOrCreateContact.bind(crm),
      getAvailableSlots: crm.getAvailableSlots.bind(crm),
      findAppointmentsFor: crm.findAppointmentsFor.bind(crm),
      cancelAppointment: crm.cancelAppointment.bind(crm),
      recordLead: crm.recordLead.bind(crm),
      bookAppointment: async () => {
        throw new CrmUnavailableError("Could not reach GoHighLevel (POST /calendars/events/appointments).");
      },
    };
    const brokenTools = buildTools(session, brokenCrm);
    const book = brokenTools.find((t) => "name" in t && t.name === "book_appointment") as {
      run: (args: unknown) => Promise<string>;
    };

    const result = await book.run({
      slot_id: slotId,
      first_name: "Dana",
      email: "dana@example.com",
    });

    expect(result).toMatch(/Nothing was saved or changed/);
    expect(result).toMatch(/Do not claim anything was booked/);
    expect(result).not.toMatch(/^Booked\./);
  });
});

describe("look_up_booking and cancel_appointment", () => {
  it("says so plainly when there are no bookings", async () => {
    const result = await tool("look_up_booking").run({ email: "nobody@example.com" });
    expect(result).toMatch(/No upcoming appointments/i);
  });

  it("requires an identifier", async () => {
    const result = await tool("look_up_booking").run({});
    expect(result).toMatch(/email or phone/i);
  });

  it("finds a booking that exists", async () => {
    await tool("check_availability").run({
      service_id: "intro-session",
      from_date: "2026-06-02",
      to_date: "2026-06-04",
    });
    const slotId = [...session.offeredSlots.keys()][0]!;
    await tool("book_appointment").run({
      slot_id: slotId,
      first_name: "Dana",
      email: "dana@example.com",
    });

    const result = await tool("look_up_booking").run({ email: "dana@example.com" });
    expect(result).toMatch(/1 upcoming appointment/i);
    expect(result).toMatch(/appointment_id: appt_/);
  });

  it("will not cancel before a customer has been identified", async () => {
    const result = await tool("cancel_appointment").run({ appointment_id: "appt_0001" });
    expect(result).toMatch(/No customer has been identified/i);
  });

  it("will not cancel an appointment belonging to someone else", async () => {
    // Dana books.
    await tool("check_availability").run({
      service_id: "intro-session",
      from_date: "2026-06-02",
      to_date: "2026-06-04",
    });
    const slotId = [...session.offeredSlots.keys()][0]!;
    await tool("book_appointment").run({
      slot_id: slotId,
      first_name: "Dana",
      email: "dana@example.com",
    });
    const danasAppointment = crm.snapshot().appointments[0]!.id;

    // Alex then identifies himself and tries to cancel Dana's slot.
    await tool("look_up_booking").run({ email: "alex@example.com" });
    const result = await tool("cancel_appointment").run({ appointment_id: danasAppointment });

    expect(result).toMatch(/doesn't belong to this customer/i);
    expect(crm.snapshot().appointments[0]!.status).toBe("booked");
  });

  it("cancels the customer's own appointment", async () => {
    await tool("check_availability").run({
      service_id: "intro-session",
      from_date: "2026-06-02",
      to_date: "2026-06-04",
    });
    const slotId = [...session.offeredSlots.keys()][0]!;
    await tool("book_appointment").run({
      slot_id: slotId,
      first_name: "Dana",
      email: "dana@example.com",
    });

    const appointmentId = crm.snapshot().appointments[0]!.id;
    const result = await tool("cancel_appointment").run({ appointment_id: appointmentId });

    expect(result).toMatch(/Cancelled/i);
    expect(crm.snapshot().appointments[0]!.status).toBe("cancelled");
  });
});

describe("save_lead", () => {
  it("refuses without a way to follow up", async () => {
    const result = await tool("save_lead").run({ first_name: "Dana", interest: "membership" });
    expect(result).toMatch(/email or phone/i);
    expect(crm.snapshot().leads).toHaveLength(0);
  });

  it("records a lead", async () => {
    const result = await tool("save_lead").run({
      first_name: "Dana",
      email: "dana@example.com",
      interest: "membership pricing",
    });
    expect(result).toMatch(/Saved/);
    expect(crm.snapshot().leads).toHaveLength(1);
  });
});

describe("escalate_to_human", () => {
  it("tells the model how to hand off", async () => {
    const result = await tool("escalate_to_human").run({
      reason: "billing dispute",
      summary: "Customer was charged twice in May.",
    });
    expect(result).toMatch(/staff follow-up/i);
    expect(result).toMatch(/555/); // the configured phone number
  });
});
