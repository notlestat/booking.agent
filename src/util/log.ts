/**
 * Logging with PII redaction.
 *
 * Customers hand this chatbot their name, email, and phone number. Those land
 * in tool arguments, which are exactly the thing you most want to log when
 * debugging an agent. So redaction happens in the logger rather than relying on
 * every call site to remember.
 */

const EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;
// Deliberately loose: catches (555) 014-2280, 555-014-2280, +1 555 014 2280.
const PHONE = /(\+?\d[\d\s().-]{7,}\d)/g;

/** Replace emails and phone numbers in a string with placeholders. */
export function redact(value: string): string {
  return value.replace(EMAIL, "[email]").replace(PHONE, "[phone]");
}

/** Redact recursively through an object, so tool-arg dumps are safe to log. */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[deep]";
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, depth + 1);
    return out;
  }
  return value;
}

type Level = "info" | "warn" | "error";

function emit(level: Level, message: string, context?: Record<string, unknown>): void {
  const line: Record<string, unknown> = {
    at: new Date().toISOString(),
    level,
    message: redact(message),
  };
  if (context) line.context = redactDeep(context);

  const serialised = JSON.stringify(line);
  if (level === "error") console.error(serialised);
  else if (level === "warn") console.warn(serialised);
  else console.log(serialised);
}

export const log = {
  info: (message: string, context?: Record<string, unknown>) => emit("info", message, context),
  warn: (message: string, context?: Record<string, unknown>) => emit("warn", message, context),
  error: (message: string, context?: Record<string, unknown>) => emit("error", message, context),
};
