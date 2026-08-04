# How it works

Written for two audiences: a future you coming back to this code, and a client
who wants to know why they should trust it.

---

## The shape of the thing

```
Browser widget
     │  POST /api/chat  { sessionId, message }
     ▼
Express server ──▶ Session (history + which slots were offered)
     │
     ▼
Agent turn ──▶ Claude, with six tools
     │              │
     │              ▼
     │         The tools — the only way anything can happen
     │              │
     ▼              ▼
  reply        CrmAdapter (interface)
                ╱          ╲
          MockCrm        GoHighLevelCrm
```

Four layers. The value is in the seams between them, not in any one layer.

---

## Why the business is a config file

`src/config/businesses/gym.ts` holds the services, hours, FAQs, policies, phone
number, and tone of voice. It is the only file that makes this a *gym* chatbot.

Everything downstream reads from it:

- The **system prompt** is generated from it (`src/agent/prompt.ts`), so the
  model's knowledge of the business and the config can't drift apart.
- **Availability** is generated from its opening hours, so the bot can never
  offer a 3am slot.
- The **widget's greeting and suggestion chips** come from it via `/api/config`.
- **Timezone handling** uses its IANA zone.

The practical consequence: retargeting to a different client is editing one file
and one export line. That's a real product claim, and it's verifiable in about a
minute — which is a better thing to be able to say than "it's flexible".

---

## Why tools instead of prompt instructions

The model never touches the CRM. It can only call six typed functions in
`src/agent/tools.ts`, with arguments Zod has already validated.

This distinction is the difference between a demo and something you'd let talk
to customers. "Don't double-book" as a sentence in a prompt is a *request*. The
model will usually honour it. Usually is not a property you can sell.

So every guarantee lives in code:

| Guarantee | Where it's enforced |
|---|---|
| Can't invent an appointment time | `book_appointment` takes a slot ID, not a date. IDs come from `check_availability` and are cached per session. |
| Can't double-book | The CRM re-checks availability at write time and throws `SlotTakenError`. |
| Can't claim a failed booking | A failed write returns an error string that says nothing was saved. No path reports success without a resolved promise. |
| Can't cancel a stranger's slot | Cancellation is scoped to the contact identified in this conversation. |

The prompt still explains *why* these rules exist — a model that understands the
constraint cooperates with it and produces better recovery behaviour. But the
prompt isn't what makes them hold.

### The slot-ID guard, specifically

This is the design decision worth understanding, because it's the classic
failure of every booking bot.

The naive design gives the model a `book_appointment(datetime, name, email)`
tool. Then a customer says "how about Tuesday at 3?" and the model, being
agreeable, books Tuesday at 3 — a time nobody ever said was free.

Instead:

1. `check_availability` returns openings, each with an ID that's a SHA-256 hash
   of the service and start time.
2. Those IDs are stored on the session in `offeredSlots`.
3. `book_appointment` accepts **only** a slot ID. There is no datetime parameter
   to fill in.
4. Before touching the CRM, it checks the ID is in `offeredSlots` for *this*
   session.

The model cannot book a time it wasn't handed, because there's no argument for
it to put a time into. A fabricated ID fails the session check; a guessed hash
is not a realistic attack. And when it does fail, the tool returns a message
telling the model to re-check availability — so the customer gets "let me look
that up" rather than an error.

`tests/tools.test.ts` attacks this directly: it fetches a real, bookable slot
behind the tool's back and tries to book it. Rejected, because that session was
never *offered* it.

---

## Why the CRM is an interface

`src/crm/types.ts` defines `CrmAdapter` in our vocabulary — contacts, slots,
appointments. Not GoHighLevel's vocabulary. Nothing above that file knows what a
"location ID" is, or that free slots come back keyed by date, or that
GoHighLevel wants epoch milliseconds.

Three payoffs:

1. **The whole flow is testable with no network.** 53 tests run in under a
   second against `MockCrm`.
2. **The mock isn't a stub.** It generates availability from real opening hours,
   enforces minimum notice, and refuses to double-book. If the flow works
   against it, the only remaining question for the real adapter is whether it
   talks to GoHighLevel correctly.
3. **A client on a different CRM is a third file**, not a refactor.

Writing the mock *first* is what forced the interface to be clean. Had the
GoHighLevel client been written first, its concepts would have leaked upward and
the second adapter would have been painful.

---

## Timezones

The single most common source of silent bugs in booking systems: an appointment
an hour off, or on the wrong day, once a year when the clocks change.

One rule, in `src/util/time.ts`:

> Every instant is stored and passed as a UTC ISO string. Conversion to a local
> wall clock happens only in `time.ts`, using the business's IANA timezone.

No other file calls `toLocaleString`, `getHours()`, or builds a Date from a
wall-clock string. That means daylight-saving bugs have exactly one place to
hide, and `tests/time.test.ts` pins that place down with fixed points on both
sides of both 2026 DST transitions.

A concrete case the tests cover: 8:30pm in Portland is 00:30 the *next day* in
UTC. Iterating "days" in UTC would file that slot under the wrong date and drop
it from Friday's availability entirely.

---

## Prompt caching, and why the clock isn't in the system prompt

Prompt caching is a *prefix match*: the cached portion has to be byte-identical
every request, and one changed byte invalidates everything after it.

The system prompt here is ~1,500 tokens of business config and is identical for
every turn of every conversation, so it's marked `cache_control: ephemeral` and
built once at module load. After the first request it's a cache read at roughly
a tenth of input price.

The model still needs to know the current time to resolve "tomorrow" and "next
Thursday" — so that goes into the **user** turn:

```
[Current date and time: Monday, June 1, 2026 at 9:00 AM EDT]

sometime thursday afternoon works
```

Putting `new Date()` in the system prompt would be the natural place for it, and
would silently break caching on every single request forever. It's the kind of
bug that costs money quietly rather than failing loudly.

---

## Model configuration

- **`claude-opus-5`** with the SDK's tool runner, which drives the
  call → run tool → feed result → repeat loop. Writing that loop by hand is a
  solved problem.
- **`effort: "medium"`** — chat is latency-sensitive and this isn't hard
  reasoning. Worth sweeping down to `low` once tool calling proves reliable.
- **Adaptive thinking left on** (the default). Disabling it on this model can
  cause a tool call to be written as plain text that silently never runs — the
  turn looks successful and nothing happens.
- **`max_iterations: 8`** — a booking needs a handful of tool calls. This bounds
  cost and stops a confused loop from running away.
- **An explicit conciseness instruction** in the prompt. The model writes long by
  default; chat bubbles need two or three sentences.

---

## Failure behaviour

Every failure path ends with the customer getting a true statement and a phone
number:

- **CRM unreachable** → the tool returns text that spells out nothing was saved
  and instructs the model not to claim otherwise.
- **Slot taken mid-booking** → apologise, re-check, offer what's actually open.
- **Model returns no text** (refusal, or hit `max_iterations`) → a real sentence
  and the gym's number, not an empty bubble.
- **Server exception** → logged with a stack trace, customer sees a plain apology.
- **Missing API key at boot** → the server refuses to start, with instructions.
  Better than discovering it mid-conversation.

The failure mode being designed against throughout: an agent that hits an error
and cheerfully says "you're all booked!"

---

## What I'd do next

In priority order:

1. **Verify the GoHighLevel adapter** against a live sub-account. It's written
   but unrun.
2. **Rate limiting and an origin check** on `/api/chat` before it's public —
   right now anyone who can reach it can spend your tokens.
3. **Streaming replies** via SSE. Contained change; meaningful UX difference.
4. **Redis-backed sessions** so it can run more than one instance.
5. **A GoHighLevel Conversations adapter** so the same agent answers SMS,
   Facebook, and Instagram — the channel layer is already separate from the
   agent.
