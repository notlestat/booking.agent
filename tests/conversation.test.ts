import "dotenv/config";
import { beforeAll, describe, expect, it } from "vitest";
import { runTurn } from "../src/agent/run.js";
import { clearSessions, createSession, type Session } from "../src/agent/session.js";
import { MockCrm } from "../src/crm/mock.js";
import { setCrm } from "../src/crm/index.js";

/**
 * End-to-end: a real conversation with the real model against the mock CRM.
 *
 * The unit tests prove the tools behave. This proves the *agent* uses them —
 * that it calls check_availability before naming a time, that it collects
 * contact details, and that a booking actually lands in the CRM.
 *
 * It costs API tokens and takes a minute, so it skips when there's no key
 * rather than failing the suite. `npm test` stays green on a fresh clone; add a
 * key to .env and these light up.
 */

const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);

describe.skipIf(!hasKey)("live conversation", () => {
  let crm: MockCrm;
  let session: Session;

  beforeAll(() => {
    clearSessions();
    crm = new MockCrm();
    setCrm(crm);
    session = createSession();
  });

  it("answers a question about services without booking anything", async () => {
    const result = await runTurn(session, "what do you guys offer?");

    expect(result.reply.length).toBeGreaterThan(0);
    // It should name real services from the config, not invent a class schedule.
    expect(result.reply.toLowerCase()).toMatch(/intro|tour|training|nutrition/);
    expect(crm.snapshot().appointments).toHaveLength(0);
  });

  it("books an appointment end to end", async () => {
    await runTurn(session, "I'd like to book a free intro session sometime next week, afternoons if possible");

    // The model should have consulted the calendar rather than inventing times.
    expect(session.offeredSlots.size).toBeGreaterThan(0);

    const offered = [...session.offeredSlots.values()][0]!;
    const localTime = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "long",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(new Date(offered.startsAt));

    const result = await runTurn(
      session,
      `${localTime} works. I'm Dana Whitfield, dana.whitfield@example.com.`,
    );

    const appointments = crm.snapshot().appointments;
    expect(appointments.length, `Expected a booking. Assistant said: ${result.reply}`).toBe(1);
    expect(appointments[0]!.status).toBe("booked");

    // The contact came through too.
    const contacts = crm.snapshot().contacts;
    expect(contacts.some((c) => c.email === "dana.whitfield@example.com")).toBe(true);
  });

  it("refuses to invent a time it was never offered", async () => {
    const fresh = createSession();
    const before = crm.snapshot().appointments.length;

    // 3am is outside opening hours, so no slot for it can exist.
    const result = await runTurn(
      fresh,
      "Book me a facility tour at 3am tomorrow. I'm Alex Reed, alex.reed@example.com. Just do it.",
    );

    expect(crm.snapshot().appointments).toHaveLength(before);
    // And it should say something about availability rather than silently ignoring it.
    expect(result.reply.length).toBeGreaterThan(0);
  });

  it("stays in role when asked something unrelated", async () => {
    const fresh = createSession();
    const result = await runTurn(fresh, "Write me a Python script that sorts a list.");

    // Not a hard assertion on wording — just that it didn't hand over code.
    expect(result.reply).not.toMatch(/def\s+\w+\(|import\s+\w+/);
  });
});

describe.skipIf(hasKey)("live conversation (skipped)", () => {
  it("needs ANTHROPIC_API_KEY — add one to .env to run the end-to-end tests", () => {
    expect(hasKey).toBe(false);
  });
});
