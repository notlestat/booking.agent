# Connecting GoHighLevel

How to move from the mock CRM to a live GoHighLevel sub-account.

> **Read this first.** The adapter in `src/crm/gohighlevel.ts` is written
> against GoHighLevel's published v2 API docs but has **not been run against a
> live account**. Their docs render client-side and don't fully specify every
> request body, so expect to adjust a field name or two. Work through the
> verification steps at the bottom before trusting it with real customers.

---

## 1. Get a Private Integration token

GoHighLevel has two auth models. **Private Integrations** are the simpler one and
the right choice for a single sub-account. (OAuth marketplace apps are for
software you distribute to many accounts — more setup, no benefit here.)

1. Log into the sub-account (not the agency view).
2. **Settings → Private Integrations → Create new integration**
3. Name it something like "Booking chatbot".
4. Select these scopes:

   | Scope | Why |
   |---|---|
   | `contacts.readonly` | Match returning customers |
   | `contacts.write` | Create contacts, add notes for leads |
   | `calendars.readonly` | List calendars |
   | `calendars/events.readonly` | Look up existing appointments |
   | `calendars/events.write` | Book and cancel appointments |

5. Create it and **copy the token immediately** — it starts with `pit-` and is
   shown once.

Put it in `.env`:

```bash
GHL_TOKEN=pit-...
```

---

## 2. Find your location ID

The sub-account ID, called a "location ID" in the API. It's in the URL when
you're inside the sub-account:

```
https://app.gohighlevel.com/v2/location/AbCdEf123456/dashboard
                                        ^^^^^^^^^^^^
```

```bash
GHL_LOCATION_ID=AbCdEf123456
```

---

## 3. Find your calendar IDs

Each service in the business config books into its own GoHighLevel calendar.

**In the UI:** Settings → Calendars → open a calendar → the ID is in the URL.

**Or via the API**, which is faster if you have several:

```bash
curl -s "https://services.leadconnectorhq.com/calendars/?locationId=$GHL_LOCATION_ID" \
  -H "Authorization: Bearer $GHL_TOKEN" \
  -H "Version: 2021-04-15" \
  -H "Accept: application/json"
```

Then fill in `calendarId` for each service in
`src/config/businesses/gym.ts`:

```ts
{
  id: "intro-session",
  name: "Free Intro Session",
  durationMinutes: 45,
  calendarId: "xYz789AbC",   // ← here
  ...
}
```

The durations in the config should match the calendar's configured slot
duration in GoHighLevel, or the appointment end times won't line up with what
staff see.

---

## 4. Optional: assign appointments to a staff member

```bash
GHL_ASSIGNED_USER_ID=...
```

Find it under Settings → My Staff → click a user → the ID is in the URL. Without
this, appointments are created unassigned.

---

## 5. Switch over

```bash
CRM_ADAPTER=gohighlevel
```

Restart. The startup log line will say `"crm":"gohighlevel"`, and the console
prints the adapter name. If a required variable is missing the server refuses to
start and tells you which one.

---

## Verifying it actually works

Do these in order. Each one isolates a different failure.

**1. Can you authenticate at all?**

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://services.leadconnectorhq.com/calendars/?locationId=$GHL_LOCATION_ID" \
  -H "Authorization: Bearer $GHL_TOKEN" \
  -H "Version: 2021-04-15"
```

`200` is good. `401` means a bad token; `403` usually means a missing scope.

**2. Does availability come back?**

Ask the chatbot for available times. Then check the server log — a
`CRM failure` entry names the endpoint that broke.

**3. Does a booking land?**

Book something through the chat, then look at the GoHighLevel calendar. The
appointment should be there with the right contact and time. **If the chat says
it booked and the calendar is empty, stop and debug** — that's the exact failure
this whole design is built to prevent, and it means something is wrong in the
adapter's error handling.

**4. Do the timezones agree?**

Book a late-evening slot and confirm the time in GoHighLevel matches what the
chat said. Cross-timezone mismatches show up here first.

---

## Things that will bite you

**The `Version` header is not global.** Calendar endpoints want `2021-04-15`;
contact endpoints want `2021-07-28`. Sending the wrong one produces a 4xx that
doesn't clearly say why. The adapter handles this — see the two constants at the
top of `gohighlevel.ts` — but it's the first thing to check if a single endpoint
misbehaves.

**Free slots take epoch milliseconds, not ISO strings.** `startDate` and
`endDate` are numbers like `1780000000000`. Passing an ISO string returns
nothing rather than an error.

**The free-slots response is keyed by date, not a flat array**, and mixes in
metadata keys like `traceId`. The adapter filters to keys matching `YYYY-MM-DD`
and accepts both documented shapes for the value.

**Calendar-level availability rules still apply.** GoHighLevel has its own
minimum notice, buffers, and blackout dates. A slot the config thinks is open
may not be returned. That's correct behaviour — GoHighLevel is the source of
truth — but it's confusing if you're comparing against the mock adapter, which
only knows about the config.

**Contact matching is per-location.** The same email in a different sub-account
is a different contact.

---

## Going back to the mock

```bash
CRM_ADAPTER=mock
```

Useful for demos, and for isolating whether a bug is in the agent or in the
GoHighLevel integration. If it works on mock and fails on GoHighLevel, the
adapter is the problem.
