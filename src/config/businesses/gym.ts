import { loadBusiness } from "../schema.js";

/**
 * Ironside Strength & Conditioning — the demo gym.
 *
 * This file is the *only* thing that makes this chatbot a gym chatbot. Copy it,
 * change the contents, point `src/config/index.ts` at the copy, and the same
 * agent now works for a salon or a dental practice.
 */
export const gym = loadBusiness({
  name: "Ironside Strength & Conditioning",
  timezone: "America/New_York",
  phone: "(555) 014-2280",
  address: "1140 Harbor Ave, Suite B, Portland, ME 04101",
  website: "https://example.com",

  tone: [
    "Warm and straightforward, like a good front-desk person who actually lifts.",
    "Never pushy. If someone is just browsing, help them browse.",
    "No hype words, no exclamation-mark spam, no emoji unless the customer uses them first.",
  ].join(" "),

  services: [
    {
      id: "intro-session",
      name: "Free Intro Session",
      durationMinutes: 45,
      description:
        "A no-cost first workout with a coach who walks you through the floor, checks your movement, and talks through your goals. Most people start here.",
      price: "Free",
      calendarId: "", // fill in when connecting GoHighLevel
    },
    {
      id: "pt-consult",
      name: "Personal Training Consultation",
      durationMinutes: 30,
      description:
        "A sit-down with a personal trainer to map out a program, discuss scheduling, and go over pricing. No workout involved.",
      price: "Free consultation",
      calendarId: "",
    },
    {
      id: "facility-tour",
      name: "Facility Tour",
      durationMinutes: 20,
      description:
        "A quick walkthrough of the gym — equipment, locker rooms, class studio. Good if you just want to see the space before committing to anything.",
      price: "Free",
      calendarId: "",
    },
    {
      id: "nutrition-consult",
      name: "Nutrition Consultation",
      durationMinutes: 45,
      description:
        "A session with our nutrition coach covering eating habits, goals, and a realistic starting plan. Available to members and non-members.",
      price: "$45 (waived for members)",
      calendarId: "",
    },
  ],

  hours: {
    mon: [{ open: "05:00", close: "21:00" }],
    tue: [{ open: "05:00", close: "21:00" }],
    wed: [{ open: "05:00", close: "21:00" }],
    thu: [{ open: "05:00", close: "21:00" }],
    fri: [{ open: "05:00", close: "20:00" }],
    sat: [{ open: "07:00", close: "17:00" }],
    sun: [{ open: "08:00", close: "14:00" }],
  },

  faqs: [
    {
      q: "How much does membership cost?",
      a: "Month-to-month is $89. A 12-month commitment brings it to $69/month. Both include unlimited classes and open-gym access. Personal training is priced separately.",
    },
    {
      q: "Am I locked into a contract?",
      a: "Only if you choose the discounted 12-month plan. The month-to-month membership can be cancelled any time with 30 days' notice.",
    },
    {
      q: "Can I bring a guest?",
      a: "Yes. Members get two guest passes a month. Guests need to sign a waiver at the front desk and bring a photo ID.",
    },
    {
      q: "Is there parking?",
      a: "There's a free lot behind the building with about 40 spaces, plus street parking on Harbor Ave. The lot fills up around 5-7pm on weeknights.",
    },
    {
      q: "Do you have childcare?",
      a: "We have supervised kids' care weekdays 8am-noon and 4pm-7pm, and Saturday mornings. It's $5 per visit or $25/month unlimited. Kids need to be 6 months or older.",
    },
    {
      q: "What should I bring to my first visit?",
      a: "Athletic shoes, comfortable clothes, and a water bottle. We supply towels. Arrive about 10 minutes early to fill out a short waiver.",
    },
  ],

  policies: {
    cancellation:
      "Appointments can be cancelled or rescheduled free of charge up to 12 hours beforehand. Inside 12 hours, we ask that you call the gym directly so we can free the coach's slot.",
    lateArrival:
      "If you're more than 15 minutes late, the coach may need to shorten the session so the next person isn't pushed back. Call ahead if you're running behind and we'll do what we can.",
    firstVisit:
      "Come 10 minutes early to sign a waiver and get a quick tour. Bring athletic shoes and a water bottle; towels are provided.",
  },

  booking: {
    minNoticeHours: 2,
    maxAdvanceDays: 30,
    slotIntervalMinutes: 30,
  },

  escalation: {
    whenUnsure:
      "Anything involving billing disputes, membership cancellations, injuries or medical concerns, complaints about staff, or corporate/group rates. Also any question where you would be guessing at the answer.",
    contactMethod:
      "Ask them to call the gym at (555) 014-2280 during staffed hours, or offer to take their name and number so a staff member can call them back.",
  },
});
