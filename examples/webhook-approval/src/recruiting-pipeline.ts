import { fromPromise, assign } from "xstate";
import { durableSetup, durableState, prompt } from "@durable-xstate/durable-machine";

// ─── Simulated async actors ────────────────────────────────────────────────

const scoreResume = fromPromise(
  async ({ input }: { input: { candidateName: string; role: string } }) => {
    // Simulate resume scoring (e.g. ATS / ML model)
    const score = Math.floor(Math.random() * 40) + 50; // 50-89
    console.log(
      `[scoreResume] Scored ${input.candidateName} for ${input.role}: ${score}`,
    );
    return { score };
  },
);

const scoreTechnical = fromPromise(
  async ({ input }: { input: { score: number } }) => {
    // Simulate technical interview evaluation
    const passed = input.score >= 7;
    console.log(
      `[scoreTechnical] Score ${input.score}/10 → ${passed ? "PASS" : "FAIL"}`,
    );
    return { passed, score: input.score };
  },
);

const scoreCulture = fromPromise(
  async ({ input }: { input: { score: number } }) => {
    // Simulate culture fit evaluation
    const passed = input.score >= 7;
    console.log(
      `[scoreCulture] Score ${input.score}/10 → ${passed ? "PASS" : "FAIL"}`,
    );
    return { passed, score: input.score };
  },
);

const runBackgroundCheck = fromPromise(
  async ({ input }: { input: { candidateName: string } }) => {
    // Simulate background check service call
    const clear = Math.random() > 0.1; // 90% chance clear
    console.log(
      `[runBackgroundCheck] ${input.candidateName}: ${clear ? "CLEAR" : "FLAGGED"}`,
    );
    return { clear };
  },
);

// ─── Machine definition ────────────────────────────────────────────────────

export const recruitingPipeline = durableSetup({
  input: { candidateName: "string", role: "string" },
  events: {
    SCREEN: {},
    TECH_FEEDBACK: { score: "number" },
    CULTURE_FEEDBACK: { score: "number" },
    ACCEPT: {},
    DECLINE: {},
  },
  actors: {
    scoreResume,
    scoreTechnical,
    scoreCulture,
    runBackgroundCheck,
  },
  delays: {
    applicationDeadline: 60_000,
    interviewDeadline: 60_000,
    offerDeadline: 60_000,
  },
  guards: {
    passingScore: ({ context }) => context.screenScore >= 70,
    allPassed: ({ context }) =>
      context.techScore >= 7 &&
      context.cultureScore >= 7,
  },
  label: "Recruiting Pipeline",
  description: "Multi-stage hiring workflow: application → screening → parallel interviews → offer",
}).createMachine({
  id: "recruiting-pipeline",
  initial: "applied",
  context: ({ input }) => ({
    candidateName: input.candidateName,
    role: input.role,
    screenScore: 0,
    techScore: 0,
    cultureScore: 0,
    backgroundClear: false,
  }),

  states: {
    // ── Wait for screening to begin ──────────────────────────────────────
    applied: {
      ...durableState({
        effects: [
          {
            type: "webhook",
            url: "https://example.com/recruiting/applied",
            candidateName: "{{ context.candidateName }}",
            role: "{{ context.role }}",
          },
        ],
      }),
      on: { SCREEN: "screening" },
      after: {
        applicationDeadline: "auto_rejected",
      },
    },

    // ── Invoke: score the resume ─────────────────────────────────────────
    screening: {
      invoke: {
        src: "scoreResume",
        input: ({ context }) => ({
          candidateName: context.candidateName,
          role: context.role,
        }),
        onDone: {
          target: "evaluating_screen",
          actions: assign({
            screenScore: ({ event }) => (event.output as any).score,
          }),
        },
        onError: "rejected",
      },
    },

    // ── Guard-based routing (always/transient) ───────────────────────────
    evaluating_screen: {
      always: [
        { guard: "passingScore", target: "interview" },
        { target: "rejected" },
      ],
    },

    // ── Parallel interview stage (technical + culture) ──────────────────
    interview: {
      type: "parallel",
      onDone: "evaluating_interviews",
      states: {
        // ── Technical interview ────────────────────────────────────────
        technical: {
          initial: "scheduled",
          states: {
            scheduled: {
              ...durableState(),
              ...prompt({
                type: "choice",
                text: ({ context }) =>
                  `Rate technical interview for ${context.candidateName} (${context.role})`,
                options: [
                  { label: "Strong (9)", event: "TECH_FEEDBACK", style: "primary" },
                  { label: "Good (7)", event: "TECH_FEEDBACK" },
                  { label: "Weak (4)", event: "TECH_FEEDBACK", style: "danger" },
                ],
              }),
              on: {
                TECH_FEEDBACK: {
                  target: "scoring",
                  actions: assign({
                    techScore: ({ event }) => event.score,
                  }),
                },
              },
              after: {
                interviewDeadline: "expired",
              },
            },
            scoring: {
              invoke: {
                src: "scoreTechnical",
                input: ({ context }) => ({ score: context.techScore }),
                onDone: [
                  {
                    guard: ({ event }) => (event.output as any).passed,
                    target: "passed",
                  },
                  { target: "failed" },
                ],
                onError: "failed",
              },
            },
            passed: { type: "final" },
            failed: { type: "final" },
            expired: { type: "final" },
          },
        },

        // ── Culture interview ──────────────────────────────────────────
        culture: {
          initial: "scheduled",
          states: {
            scheduled: {
              ...durableState(),
              ...prompt({
                type: "choice",
                text: ({ context }) =>
                  `Rate culture interview for ${context.candidateName}`,
                options: [
                  { label: "Strong (9)", event: "CULTURE_FEEDBACK", style: "primary" },
                  { label: "Good (7)", event: "CULTURE_FEEDBACK" },
                  { label: "Weak (4)", event: "CULTURE_FEEDBACK", style: "danger" },
                ],
              }),
              on: {
                CULTURE_FEEDBACK: {
                  target: "scoring",
                  actions: assign({
                    cultureScore: ({ event }) => event.score,
                  }),
                },
              },
              after: {
                interviewDeadline: "expired",
              },
            },
            scoring: {
              invoke: {
                src: "scoreCulture",
                input: ({ context }) => ({ score: context.cultureScore }),
                onDone: [
                  {
                    guard: ({ event }) => (event.output as any).passed,
                    target: "passed",
                  },
                  { target: "failed" },
                ],
                onError: "failed",
              },
            },
            passed: { type: "final" },
            failed: { type: "final" },
            expired: { type: "final" },
          },
        },
      },
    },

    // ── Reference / background check (after both interviews) ──────────
    references: {
      invoke: {
        src: "runBackgroundCheck",
        input: ({ context }) => ({
          candidateName: context.candidateName,
        }),
        onDone: [
          {
            guard: ({ event }) => (event.output as any).clear,
            target: "offer",
            actions: assign({ backgroundClear: true }),
          },
          { target: "rejected" },
        ],
        onError: "rejected",
      },
    },

    // ── Guard-based routing after interviews ─────────────────────────
    evaluating_interviews: {
      always: [
        { guard: "allPassed", target: "references" },
        { target: "rejected" },
      ],
    },

    // ── Offer stage ──────────────────────────────────────────────────────
    offer: {
      ...durableState({
        effects: [
          {
            type: "webhook",
            url: "https://example.com/recruiting/offer",
            candidateName: "{{ context.candidateName }}",
            role: "{{ context.role }}",
          },
        ],
      }),
      ...prompt({
        type: "choice",
        text: ({ context }) =>
          `Extend offer to ${context.candidateName} for ${context.role}?`,
        options: [
          { label: "Accept Offer", event: "ACCEPT", style: "primary" },
          { label: "Decline Offer", event: "DECLINE", style: "danger" },
        ],
      }),
      on: {
        ACCEPT: "hired",
        DECLINE: "rejected",
      },
      after: {
        offerDeadline: "offer_expired",
      },
    },

    // ── Terminal states ──────────────────────────────────────────────────
    hired: { type: "final" },
    rejected: { type: "final" },
    auto_rejected: { type: "final" },
    offer_expired: { type: "final" },
  },
});
