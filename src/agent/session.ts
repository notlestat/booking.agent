import type Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import type { Slot } from "../crm/types.js";

/**
 * Per-conversation state.
 *
 * Two things live here, and the second one is load-bearing for correctness:
 *
 * 1. `messages` — the conversation history. The Messages API is stateless, so
 *    the full history is re-sent every turn; this is where it accumulates.
 *
 * 2. `offeredSlots` — every slot ID this session has actually been shown.
 *    `book_appointment` refuses any ID that isn't in here. This is what makes
 *    "the model invented an appointment time" structurally impossible rather
 *    than merely discouraged: the model can only pass back an ID the server
 *    handed it, and IDs are hashes, so guessing one is not a realistic path.
 *
 * Storage is an in-memory Map. That's honest for a demo and wrong for
 * production — two server instances behind a load balancer would not share
 * sessions. Swap this for Redis when it matters; the interface is small enough
 * that it's a contained change.
 */

const SESSION_TTL_MS = 60 * 60 * 1000; // an hour of inactivity
const MAX_HISTORY_MESSAGES = 60; // roughly 30 exchanges

export interface Session {
  id: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  /** Slot ID -> the slot, for every option this session has been offered. */
  offeredSlots: Map<string, Slot>;
  /** The contact, once identified. Lets follow-up turns skip re-asking. */
  contactId?: string;
  /** Appointments booked in this conversation — surfaced to the widget. */
  bookedAppointmentIds: string[];
  createdAt: number;
  lastActiveAt: number;
}

const sessions = new Map<string, Session>();

export function createSession(): Session {
  const now = Date.now();
  const session: Session = {
    id: randomUUID(),
    messages: [],
    offeredSlots: new Map(),
    bookedAppointmentIds: [],
    createdAt: now,
    lastActiveAt: now,
  };
  sessions.set(session.id, session);
  return session;
}

/** Fetch a session by ID, or create a fresh one if it's unknown or expired. */
export function getOrCreateSession(id?: string): Session {
  sweepExpired();
  if (id) {
    const existing = sessions.get(id);
    if (existing) {
      existing.lastActiveAt = Date.now();
      return existing;
    }
  }
  return createSession();
}

/** Record slots we've shown the customer, so booking can validate against them. */
export function rememberOfferedSlots(session: Session, slots: Slot[]): void {
  for (const slot of slots) session.offeredSlots.set(slot.id, slot);
}

/**
 * Trim history so a very long conversation can't grow the request unbounded.
 *
 * We drop from the front, but never leave the array starting on an assistant
 * turn or on a tool_result — the API requires the first message to be `user`,
 * and a tool_result with no preceding tool_use is rejected.
 */
export function trimHistory(session: Session): void {
  if (session.messages.length <= MAX_HISTORY_MESSAGES) return;

  let start = session.messages.length - MAX_HISTORY_MESSAGES;
  while (start < session.messages.length) {
    const candidate = session.messages[start];
    if (candidate?.role === "user" && !startsWithToolResult(candidate)) break;
    start += 1;
  }
  session.messages = session.messages.slice(start);
}

function startsWithToolResult(message: Anthropic.Beta.BetaMessageParam): boolean {
  if (typeof message.content === "string") return false;
  return message.content.some((block) => block.type === "tool_result");
}

function sweepExpired(): void {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, session] of sessions) {
    if (session.lastActiveAt < cutoff) sessions.delete(id);
  }
}

/** Test/debug helper. */
export function sessionCount(): number {
  return sessions.size;
}

/** Test helper — drop all state between test cases. */
export function clearSessions(): void {
  sessions.clear();
}
