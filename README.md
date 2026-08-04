# Booking Agent

[!\[CI\](https://github.com/notlestat/ai-booking-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/notlestat/ai-booking-agent/actions/workflows/ci.yml)

An AI chat assistant that answers questions about a business and books
appointments into its CRM. Configured for a gym, with GoHighLevel as the CRM —
but the business is a config file and the CRM is an interface, so neither is
baked in.

The chat widget drops onto any website with one script tag.

---

## Quick start

```bash
npm install
cp .env.example .env        # then add your ANTHROPIC_API_KEY
npm run dev
```

Open <http://localhost:3000> and click the chat bubble in the corner.

No GoHighLevel account is needed. The default `CRM_ADAPTER=mock` runs an
in-memory CRM that generates real availability from the configured opening
hours, so the full booking flow works offline.

**Verify a booking was real:** after the assistant confirms a booking, open
<http://localhost:3000/api/debug/state>. The contact and appointment are there,
or the booking didn't happen — regardless of what the assistant said.

---

## What it does

- Answers questions about services, pricing, hours, and policies from a config file
- Checks real calendar availability before offering any time
- Books appointments, capturing the customer as a CRM contact
- Looks up, and cancels, existing bookings
- Captures leads who aren't ready to book
- Escalates to a human on billing, injuries, complaints, or anything it can't answer

## What it deliberately cannot do

These are enforced in TypeScript, not requested in the prompt:

- **Invent an appointment time.** `book_appointment` accepts a slot ID and has
  no date parameter. Slot IDs are hashes issued by `check_availability` and
  cached per session; anything else is rejected.
- **Double-book.** Availability is re-checked at write time, not just when the
  slot was offered. The second of two racing bookings fails.
- **Claim a booking that failed.** A failed write returns an error to the model
  that says so explicitly. There is no code path that reports success without a
  resolved write.
- **Cancel a stranger's appointment.** Cancellation is scoped to the contact
  identified in the current conversation.

Each of these has a test that attacks it directly, bypassing the model:
`tests/tools.test.ts`.

---

## Layout

```javascript
src/
  config/     the business — services, hours, FAQs, policies, tone
  crm/        the CRM port, plus mock and GoHighLevel adapters
  agent/      system prompt, tools, session state, the turn loop
  server/     Express app and routes
  util/       timezone conversion and PII-redacting logs
public/       the embeddable chat widget
tests/        unit tests, tool-guard tests, live end-to-end tests
docs/         how it works, and GoHighLevel setup
```

Read [`docs/HOW-IT-WORKS.md`](docs/HOW-IT-WORKS.md) for the design reasoning.

---

## Pointing it at a different business

Copy `src/config/businesses/gym.ts`, edit the contents, and change one line in
`src/config/index.ts`:

```ts
export const business: Business = mySalon;
```

The system prompt, the tool descriptions, availability generation, the widget's
greeting, and the timezone all follow from that file. Nothing else needs to
change to serve a salon, a dental practice, or a physio clinic.

---

## Connecting GoHighLevel

```bash
CRM_ADAPTER=gohighlevel
GHL_TOKEN=pit-...
GHL_LOCATION_ID=...
```

Plus a `calendarId` on each service in the business config. Step-by-step
instructions are in [`docs/GHL-SETUP.md`](docs/GHL-SETUP.md).

> **Status of the GoHighLevel adapter:** written against the published v2 API
> docs, but **not yet run against a live account**. The mock adapter is the one
> exercised by the test suite. Before putting this in front of customers, work
> through `docs/GHL-SETUP.md` and confirm each call. Expect to adjust field
> names — GoHighLevel's docs render client-side and some request bodies aren't
> fully specified in them.

---

## Commands

| Command             | What it does                                     |
| ------------------- | ------------------------------------------------ |
| `npm run dev`       | Start with hot reload on <http://localhost:3000> |
| `npm test`          | Run the test suite                               |
| `npm run typecheck` | Type-check without emitting                      |
| `npm run build`     | Compile to `dist/`                               |
| `npm start`         | Run the compiled build                           |

`npm test` passes on a fresh clone with no API key — the live end-to-end tests
skip themselves. Add a key to `.env` and they run.

---

## Embedding the widget

```html
<link rel="stylesheet" href="https://your-host/widget.css">
<script src="https://your-host/widget.js" data-api="https://your-host"></script>
```

No framework, no build step, \~250 lines of plain JavaScript. Styles are
namespaced under `.bkw-` so they can't collide with the host page.

---

## Known limitations

Honest list, because these matter if you deploy it:

- **Sessions are in-memory.** Fine for one server; two instances behind a load
  balancer would not share conversation state. Swap `src/agent/session.ts` for
  Redis before scaling out.
- **The GoHighLevel adapter is unverified** against a live account (see above).
- **No authentication on /api/chat.** Anyone who can reach the endpoint can
  spend your API tokens. Put it behind rate limiting and an origin check before
  exposing it publicly.
- **Replies aren't streamed.** The customer waits for the full response. SSE
  streaming is a contained change to `runTurn` and the widget's fetch call.
- **One business per deployment.** Multi-tenancy would mean keying the config by
  hostname rather than importing it directly.
