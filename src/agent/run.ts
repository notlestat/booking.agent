import Anthropic from "@anthropic-ai/sdk";
import { business } from "../config/index.js";
import { getCrm } from "../crm/index.js";
import { log } from "../util/log.js";
import { describeNow } from "../util/time.js";
import { buildSystemPrompt } from "./prompt.js";
import { type Session, trimHistory } from "./session.js";
import { buildTools } from "./tools.js";

/**
 * One turn of the conversation: customer message in, assistant reply out.
 *
 * The tool-calling loop (call model -> run tools -> feed results back -> repeat
 * until it stops asking for tools) is handled by the SDK's tool runner. We
 * supply the tools; it drives the loop. Writing that loop by hand is a solved
 * problem and not where the value is.
 */

const MODEL = "claude-opus-5";

/**
 * Built once at module load, not per request.
 *
 * This matters for prompt caching: the cache is a *prefix match*, so the system
 * prompt has to be byte-identical every time. Rebuild it per request with any
 * varying content and every request pays full input price.
 */
const SYSTEM_PROMPT = buildSystemPrompt(business);

let client: Anthropic | undefined;

function getClient(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key from https://console.anthropic.com/",
      );
    }
    client = new Anthropic();
  }
  return client;
}

export interface TurnResult {
  reply: string;
  /** Appointment IDs booked during this turn, so the UI can react. */
  bookedAppointmentIds: string[];
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
}

export async function runTurn(session: Session, userMessage: string): Promise<TurnResult> {
  const bookedBefore = session.bookedAppointmentIds.length;

  // The current time goes in the USER turn, never the system prompt. The model
  // needs it to resolve "tomorrow" and "next Thursday", but a timestamp in the
  // cached prefix would invalidate the cache on every single request.
  const dated = `[Current date and time: ${describeNow(new Date(), business.timezone)}]\n\n${userMessage}`;

  session.messages.push({ role: "user", content: dated });
  trimHistory(session);

  const runner = getClient().beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 2048,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        // Cache the system prompt: it's identical across every turn of every
        // conversation, so after the first request it should be a cache read
        // at ~10% of input price.
        cache_control: { type: "ephemeral" },
      },
    ],
    // Chat is latency-sensitive and this task isn't hard reasoning. Leave
    // adaptive thinking on (the default) — disabling it on this model can cause
    // a tool call to be written as plain text and silently never run.
    output_config: { effort: "medium" },
    tools: buildTools(session, getCrm()),
    messages: session.messages,
    // A booking conversation needs a handful of tool calls, not twenty. This
    // bounds cost and stops a confused loop from running away.
    max_iterations: 8,
  });

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;

  // Drive the loop ourselves so history accumulates in the session. The runner
  // executes tools; `generateToolResponse` returns the results it produced
  // (cached, so tools don't run twice).
  for await (const message of runner) {
    inputTokens += message.usage.input_tokens ?? 0;
    outputTokens += message.usage.output_tokens ?? 0;
    cacheReadTokens += message.usage.cache_read_input_tokens ?? 0;

    session.messages.push({ role: "assistant", content: message.content });

    const toolResponse = await runner.generateToolResponse();
    if (toolResponse) session.messages.push(toolResponse);
  }

  const final = await runner.done();
  const reply = extractText(final);

  session.lastActiveAt = Date.now();

  log.info("Turn complete", {
    sessionId: session.id,
    stopReason: final.stop_reason,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    historyLength: session.messages.length,
  });

  return {
    reply: reply || fallbackReply(final),
    bookedAppointmentIds: session.bookedAppointmentIds.slice(bookedBefore),
    usage: { inputTokens, outputTokens, cacheReadTokens },
  };
}

function extractText(message: Anthropic.Beta.BetaMessage): string {
  return message.content
    .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

/**
 * What to say when the model produced no text.
 *
 * Two realistic causes: the safety classifier declined (`stop_reason:
 * "refusal"`), or we hit `max_iterations` mid-tool-loop. Either way the
 * customer gets a real sentence and a phone number rather than an empty bubble.
 */
function fallbackReply(message: Anthropic.Beta.BetaMessage): string {
  if (message.stop_reason === "refusal") {
    return `I'm not able to help with that one. For anything I can't handle, give the gym a call on ${business.phone}.`;
  }
  return `Sorry — I got tangled up there and didn't finish. Could you say that again? If it's easier, the gym's number is ${business.phone}.`;
}
