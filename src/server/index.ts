import "dotenv/config";

import express from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { business } from "../config/index.js";
import { getCrm } from "../crm/index.js";
import { log } from "../util/log.js";
import { chatRouter } from "./routes/chat.js";

// `__dirname` does not exist in ES modules. This is the ESM equivalent.
const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "..", "..", "public");

const app = express();

app.use(express.json({ limit: "64kb" }));
app.use("/api", chatRouter);
app.use(express.static(publicDir));

// Errors that escape a route handler.
app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  log.error("Unhandled server error", { message: error.message, stack: error.stack });
  res.status(500).json({ error: "Internal server error." });
});

const port = Number(process.env.PORT ?? 3000);

/**
 * Fail fast on misconfiguration.
 *
 * Both of these are things you'd otherwise discover mid-conversation, in front
 * of a customer, as a confusing error. Better to refuse to start.
 */
function preflight(): void {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set.\n" +
        "  1. Copy .env.example to .env\n" +
        "  2. Add your key from https://console.anthropic.com/",
    );
  }
  // Constructing the CRM validates its own config (e.g. GHL_TOKEN when
  // CRM_ADAPTER=gohighlevel) and throws with a pointer to the fix.
  getCrm();
}

try {
  preflight();
} catch (error) {
  console.error(`\nCannot start:\n\n${(error as Error).message}\n`);
  process.exit(1);
}

app.listen(port, () => {
  log.info("Server listening", {
    port,
    business: business.name,
    timezone: business.timezone,
    crm: getCrm().name,
  });
  console.log(`\n  ${business.name} booking assistant`);
  console.log(`  http://localhost:${port}`);
  console.log(`  CRM adapter: ${getCrm().name}\n`);
});
