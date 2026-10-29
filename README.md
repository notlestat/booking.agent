# Booking Agent

[![CI](https://github.com/notlestat/booking.agent/actions/workflows/ci.yml/badge.svg)](https://github.com/notlestat/booking.agent/actions/workflows/ci.yml)

A TypeScript chat assistant for business questions and appointment booking. Business details come from configuration. The CRM interface has an in-memory mock and a GoHighLevel adapter.

The mock supports local development. The GoHighLevel adapter has not been verified against a live account.

## Run locally

Use Node.js 20+ and npm. Chat requires an Anthropic API key and network access even with the mock CRM. The configured model is `claude-opus-5` in [src/agent/run.ts](src/agent/run.ts). Model access depends on your account.

```sh
git clone https://github.com/notlestat/booking.agent.git
cd booking.agent
npm ci
cp .env.example .env
```

Set `ANTHROPIC_API_KEY` in `.env`. Keep `CRM_ADAPTER=mock` for local CRM state, then start the server:

```sh
npm run dev
```

Open <http://localhost:3000> and choose the chat bubble. With the mock adapter in development mode, inspect <http://localhost:3000/api/debug/state> to confirm that a contact and appointment were stored. A model reply alone does not establish a booking.

## Configure the business

Copy [src/config/businesses/gym.ts](src/config/businesses/gym.ts) and edit the business data. Import the new export in [src/config/index.ts](src/config/index.ts), then assign it to `business`.

The prompt, timezone, services, and mock opening hours use that configuration. Review the widget suggestions and tool wording too. Some gym-specific text remains in [src/server/routes/chat.ts](src/server/routes/chat.ts) and [src/agent/tools.ts](src/agent/tools.ts).

For GoHighLevel, set `CRM_ADAPTER=gohighlevel`, `GHL_TOKEN`, and `GHL_LOCATION_ID`, then add a `calendarId` to each service. Follow [the GoHighLevel setup guide](docs/GHL-SETUP.md) and verify the calls with a controlled account before customer use.

## Booking behavior and limits

- `book_appointment` accepts only a slot ID offered in the current session. It cannot accept an arbitrary date.
- The mock rejects a second write to the same slot ID. The GoHighLevel adapter rechecks availability before writing, but live conflict handling remains unverified.
- The booking tool returns success after the CRM write resolves. The model can still produce an inaccurate reply. Inspect CRM state when verifying results.
- Cancellation checks that the appointment belongs to the contact selected in the conversation. Email or phone lookup does not verify the requester's identity.
- Human escalation writes a log entry and returns configured contact instructions. It does not send a staff notification.

[tests/tools.test.ts](tests/tools.test.ts) exercises the tool guards using the mock CRM. These checks do not establish live-provider behavior or customer authentication.

## Check a change

To run local tests without paid conversation calls, clear the API key for the test process:

```sh
ANTHROPIC_API_KEY= npm test
npm run typecheck
npm run build
```

The empty value also prevents a key in `.env` from enabling live tests. A nonempty key enables conversation tests that call Anthropic. Build before running `npm start`, which serves the compiled output in `dist/`.

## Environment variables

Copy [.env.example](.env.example) and set the values needed by your selected adapter:

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Chat API access |
| `CRM_ADAPTER` | `mock` by default, or `gohighlevel` |
| `GHL_TOKEN`, `GHL_LOCATION_ID` | GoHighLevel access |
| `GHL_ASSIGNED_USER_ID` | Optional staff assignment |
| `PORT` | Server port, default `3000` |
| `NODE_ENV` | `production` disables `/api/debug/*` |

## Embed the widget

Serve the widget and API from the same origin, or configure server CORS before using separate origins:

```html
<link rel="stylesheet" href="https://your-host/widget.css">
<script src="https://your-host/widget.js" data-api="https://your-host"></script>
```

The widget has no frontend build step. The Express server has no CORS middleware, authentication, or rate limiting. Review those controls before public hosting.

Session state and mock CRM data live in memory and disappear on restart. Instances do not share state. Replies are not streamed, and one business configuration is active per process.

Read [How it works](docs/HOW-IT-WORKS.md) for the existing design explanation.
