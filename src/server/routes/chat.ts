import { Router } from "express";
import { runTurn } from "../../agent/run.js";
import { getOrCreateSession } from "../../agent/session.js";
import { business } from "../../config/index.js";
import { getCrm, MockCrm } from "../../crm/index.js";
import { log } from "../../util/log.js";

export const chatRouter: Router = Router();

const MAX_MESSAGE_LENGTH = 2000;

/**
 * POST /api/chat
 *
 * The whole conversational surface. Takes a message and an optional session ID,
 * returns the assistant's reply and the session ID to send next time.
 */
chatRouter.post("/chat", async (req, res) => {
  const body = req.body as { sessionId?: unknown; message?: unknown } | undefined;

  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!message) {
    res.status(400).json({ error: "A non-empty `message` string is required." });
    return;
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    res.status(400).json({ error: `Messages are limited to ${MAX_MESSAGE_LENGTH} characters.` });
    return;
  }

  const sessionId = typeof body?.sessionId === "string" ? body.sessionId : undefined;
  const session = getOrCreateSession(sessionId);

  try {
    const result = await runTurn(session, message);
    res.json({
      sessionId: session.id,
      reply: result.reply,
      bookedAppointmentIds: result.bookedAppointmentIds,
    });
  } catch (error) {
    // The customer gets a usable sentence and a phone number. The stack trace
    // goes to the log, not to the browser.
    log.error("Chat turn failed", {
      sessionId: session.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    res.status(500).json({
      sessionId: session.id,
      reply: `Something went wrong on our end — sorry. Give the gym a call on ${business.phone} and someone will sort you out.`,
      bookedAppointmentIds: [],
    });
  }
});

/**
 * GET /api/config
 *
 * Lets the widget render the business name and greeting without hardcoding
 * them, so pointing the app at a different business updates the UI too.
 */
chatRouter.get("/config", (_req, res) => {
  res.json({
    name: business.name,
    phone: business.phone,
    greeting: `Hi! I'm the booking assistant for ${business.name}. I can answer questions or get you booked in — what are you after?`,
    suggestions: [
      "What do you offer?",
      "I'd like to try a free session",
      "How much is membership?",
    ],
  });
});

/**
 * GET /api/debug/state  (development only)
 *
 * Proof that a booking actually hit the CRM rather than the model just saying
 * it did. Disabled when NODE_ENV=production.
 */
chatRouter.get("/debug/state", (_req, res) => {
  if (process.env.NODE_ENV === "production") {
    res.status(404).json({ error: "Not found." });
    return;
  }

  const crm = getCrm();
  if (!(crm instanceof MockCrm)) {
    res.json({
      adapter: crm.name,
      note: "State inspection is only available with the mock adapter. Check the GoHighLevel calendar directly.",
    });
    return;
  }

  res.json({ adapter: crm.name, ...crm.snapshot() });
});
