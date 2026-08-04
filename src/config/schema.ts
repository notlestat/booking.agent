import { z } from "zod";

/**
 * The shape of a business this agent can represent.
 *
 * This is the file you edit to point the whole chatbot at a different client.
 * Nothing here is gym-specific: a salon, a dental office, or a physio clinic is
 * a different instance of this same schema.
 *
 * It is validated at startup (see `loadBusiness`) so a malformed config fails
 * loudly on boot instead of halfway through a customer conversation.
 */

const timeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be 24-hour HH:MM, e.g. 09:00 or 17:30");

const openingHours = z.object({
  open: timeOfDay,
  close: timeOfDay,
});

export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const service = z.object({
  /** Stable machine ID. The model passes this to tools, so keep it readable. */
  id: z.string().min(1),
  name: z.string().min(1),
  durationMinutes: z.number().int().positive(),
  /** One or two sentences. This is shown to the customer verbatim. */
  description: z.string().min(1),
  /** Free text so "Free", "$49", and "From $120/mo" are all expressible. */
  price: z.string().optional(),
  /**
   * The GoHighLevel calendar this service books into.
   * Ignored by the mock CRM; required once CRM_ADAPTER=gohighlevel.
   */
  calendarId: z.string().optional(),
});

export const businessSchema = z.object({
  name: z.string().min(1),
  /** IANA timezone, e.g. "America/New_York". Everything user-facing renders here. */
  timezone: z.string().min(1),
  phone: z.string().min(1),
  address: z.string().min(1),
  website: z.string().url().optional(),

  /** How the agent should sound. Fed directly into the system prompt. */
  tone: z.string().min(1),

  services: z.array(service).min(1),

  /** Days absent from this map are treated as closed. */
  hours: z.record(z.enum(WEEKDAYS), z.array(openingHours)),

  faqs: z.array(z.object({ q: z.string().min(1), a: z.string().min(1) })).default([]),

  policies: z.object({
    cancellation: z.string().min(1),
    lateArrival: z.string().min(1),
    firstVisit: z.string().min(1),
  }),

  booking: z.object({
    /** Don't offer slots sooner than this — staff need lead time. */
    minNoticeHours: z.number().int().nonnegative().default(2),
    /** Don't offer slots further out than this. */
    maxAdvanceDays: z.number().int().positive().default(30),
    /** Grid the day into slots this many minutes apart. */
    slotIntervalMinutes: z.number().int().positive().default(30),
  }),

  escalation: z.object({
    /** Situations where the agent should stop and hand off to a human. */
    whenUnsure: z.string().min(1),
    /** What the agent tells the customer to do. */
    contactMethod: z.string().min(1),
  }),
});

export type Business = z.infer<typeof businessSchema>;
export type Service = z.infer<typeof service>;
export type OpeningHours = z.infer<typeof openingHours>;

/**
 * Validate a config and fail fast with a readable error.
 * Called once at startup, never per-request.
 */
export function loadBusiness(raw: unknown): Business {
  const result = businessSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid business config:\n${issues}`);
  }

  // Cross-field checks Zod can't express on its own.
  const business = result.data;

  const ids = business.services.map((s) => s.id);
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (duplicates.length > 0) {
    throw new Error(`Invalid business config: duplicate service id(s): ${[...new Set(duplicates)].join(", ")}`);
  }

  for (const [day, ranges] of Object.entries(business.hours)) {
    for (const range of ranges ?? []) {
      if (range.open >= range.close) {
        throw new Error(
          `Invalid business config: hours.${day} has open (${range.open}) at or after close (${range.close}).`,
        );
      }
    }
  }

  // A timezone typo is silent and corrupts every time we display — check it now.
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: business.timezone });
  } catch {
    throw new Error(`Invalid business config: "${business.timezone}" is not a recognised IANA timezone.`);
  }

  return business;
}
