import { log } from "../util/log.js";
import { GoHighLevelCrm } from "./gohighlevel.js";
import { MockCrm } from "./mock.js";
import type { CrmAdapter } from "./types.js";

export * from "./types.js";
export { MockCrm } from "./mock.js";
export { GoHighLevelCrm } from "./gohighlevel.js";

let instance: CrmAdapter | undefined;

/**
 * The active CRM, chosen by the CRM_ADAPTER env var.
 *
 * Nothing above this function knows which one it got. That's the whole design:
 * `mock` and `gohighlevel` satisfy the same interface, so the agent, the tools,
 * and the tests are identical either way.
 */
export function getCrm(): CrmAdapter {
  if (instance) return instance;

  const choice = (process.env.CRM_ADAPTER ?? "mock").trim().toLowerCase();

  if (choice === "gohighlevel") {
    const token = requireEnv("GHL_TOKEN");
    const locationId = requireEnv("GHL_LOCATION_ID");
    instance = new GoHighLevelCrm({
      token,
      locationId,
      assignedUserId: process.env.GHL_ASSIGNED_USER_ID || undefined,
    });
    log.info("CRM adapter selected", { adapter: "gohighlevel", locationId });
    return instance;
  }

  if (choice !== "mock") {
    throw new Error(`CRM_ADAPTER must be "mock" or "gohighlevel", got "${choice}".`);
  }

  instance = new MockCrm();
  log.info("CRM adapter selected", { adapter: "mock" });
  return instance;
}

/** Test seam: point the app at a specific adapter instance. */
export function setCrm(adapter: CrmAdapter): void {
  instance = adapter;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `CRM_ADAPTER=gohighlevel requires ${name}. ` +
        `Set it in .env, or switch to CRM_ADAPTER=mock to run without GoHighLevel. ` +
        `See docs/GHL-SETUP.md.`,
    );
  }
  return value;
}
