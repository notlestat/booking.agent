import type { Business, Service } from "./schema.js";
import { gym } from "./businesses/gym.js";

/**
 * The active business.
 *
 * Swapping the whole chatbot to a different client is this one line. Everything
 * downstream — system prompt, tool descriptions, availability generation,
 * timezone handling — reads from here.
 */
export const business: Business = gym;

export type { Business, Service };
export { WEEKDAYS } from "./schema.js";
export type { Weekday, OpeningHours } from "./schema.js";

/** Look up a service by ID, or `undefined` if the ID isn't real. */
export function findService(serviceId: string): Service | undefined {
  return business.services.find((s) => s.id === serviceId);
}

/** Service IDs, for building tool enums and validating model input. */
export function serviceIds(): string[] {
  return business.services.map((s) => s.id);
}
