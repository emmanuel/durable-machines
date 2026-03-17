import type { MachineDefinition, StateDefinition } from "@durable-xstate/durable-machine";
import type { CourseStructure, BlockChild, AUDefinition, BlockDefinition } from "./types.js";
import { buildGuards, buildAUActions, buildCompletionActions, buildSessionActions } from "./expr-builders.js";

const MACHINE_ID = "registration";

/**
 * Generate a fully JSON-serializable {@link MachineDefinition} for a CMI5
 * registration machine from a parsed course structure.
 *
 * The definition uses expr-based guards and actions (compiled at machine
 * creation time by `createMachineFromDefinition`). No function bodies —
 * only JSON data.
 */
export function createRegistrationDefinition(cs: CourseStructure): MachineDefinition {
  // Index mapping: real IDs → index-based state keys
  const auIndex = new Map<string, { key: string; idx: number }>();
  const blockIndex = new Map<string, { key: string; idx: number }>();
  let auCounter = 0;
  let blockCounter = 0;

  indexChildren(cs.rootChildren, cs);

  function indexChildren(children: BlockChild[], structure: CourseStructure): void {
    for (const child of children) {
      if (child.type === "au") {
        auIndex.set(child.id, { key: `au_${auCounter}`, idx: auCounter });
        auCounter++;
      } else {
        const block = structure.blocks[child.id];
        blockIndex.set(child.id, { key: `block_${blockCounter}`, idx: blockCounter });
        blockCounter++;
        indexChildren(block.children, structure);
      }
    }
  }

  const context = buildContext(cs);
  const trackingState = buildTrackingRegion(cs, auIndex, blockIndex);
  const trackingDoneEvent = doneEventName(MACHINE_ID, "active", "tracking");

  const activeState: StateDefinition = {
    type: "parallel",
    on: { [trackingDoneEvent]: { actions: "satisfyCourse" } },
    states: {
      tracking: trackingState,
      sessions: buildSessionsRegion(),
    },
  };

  return {
    id: MACHINE_ID,
    initial: "active",
    context,
    states: { active: activeState },
    guards: buildGuards(),
    actions: { ...buildAUActions(), ...buildCompletionActions(), ...buildSessionActions() },
  };
}

// ─── Context ───────────────────────────────────────────────────────────────

function buildContext(cs: CourseStructure): Record<string, unknown> {
  const ausContext: Record<string, unknown> = {};
  for (const au of Object.values(cs.aus)) {
    ausContext[au.id] = {
      hasCompleted: false, hasPassed: false, hasFailed: false, hasWaived: false,
      method: null, satisfiedAt: null, score: null,
    };
  }

  const auTitles: Record<string, string> = {};
  for (const au of Object.values(cs.aus)) auTitles[au.id] = au.title;
  const blockTitles: Record<string, string> = {};
  for (const block of Object.values(cs.blocks)) blockTitles[block.id] = block.title;

  return {
    registrationId: null,
    actor: null,
    metadata: { courseId: cs.id, courseTitle: cs.title, auTitles, blockTitles },
    aus: ausContext,
    sessions: {},
    satisfiedBlocks: [],
    courseSatisfied: false,
    courseSatisfiedAt: null,
    lastSatisfyingSessionId: null,
  };
}

// ─── Topology builders ─────────────────────────────────────────────────────

function buildTrackingRegion(
  cs: CourseStructure,
  auIndex: Map<string, { key: string }>,
  blockIndex: Map<string, { key: string }>,
): StateDefinition {
  const states: Record<string, StateDefinition> = {};
  const onHandlers: Record<string, unknown> = {};

  for (const child of cs.rootChildren) {
    if (child.type === "au") {
      states[auIndex.get(child.id)!.key] = buildAURegion(cs.aus[child.id]);
    } else {
      const block = cs.blocks[child.id];
      const { key } = blockIndex.get(child.id)!;
      states[key] = buildBlockRegion(block, cs, auIndex, blockIndex, [MACHINE_ID, "active", "tracking"]);
      onHandlers[doneEventName(MACHINE_ID, "active", "tracking", key)] = {
        actions: { type: "satisfyBlock", params: { blockId: child.id } },
      };
    }
  }

  const state: StateDefinition = { type: "parallel", states };
  if (Object.keys(onHandlers).length > 0) state.on = onHandlers as any;
  return state;
}

function buildBlockRegion(
  block: BlockDefinition,
  cs: CourseStructure,
  auIndex: Map<string, { key: string }>,
  blockIndex: Map<string, { key: string }>,
  parentPath: string[],
): StateDefinition {
  const blockKey = blockIndex.get(block.id)!.key;
  const blockPath = [...parentPath, blockKey];
  const states: Record<string, StateDefinition> = {};
  const onHandlers: Record<string, unknown> = {};

  for (const child of block.children) {
    if (child.type === "au") {
      states[auIndex.get(child.id)!.key] = buildAURegion(cs.aus[child.id]);
    } else {
      const sub = cs.blocks[child.id];
      const { key } = blockIndex.get(child.id)!;
      states[key] = buildBlockRegion(sub, cs, auIndex, blockIndex, blockPath);
      onHandlers[doneEventName(MACHINE_ID, ...blockPath, key)] = {
        actions: { type: "satisfyBlock", params: { blockId: child.id } },
      };
    }
  }

  const state: StateDefinition = { type: "parallel", states };
  if (Object.keys(onHandlers).length > 0) state.on = onHandlers as any;
  return state;
}

function buildAURegion(au: AUDefinition): StateDefinition {
  if (au.moveOn === "NotApplicable") {
    return {
      initial: "unsatisfied",
      states: {
        unsatisfied: {
          always: { target: "satisfied", actions: { type: "satisfyNotApplicableAU", params: { auId: au.id } } },
        },
        satisfied: { type: "final" },
      },
    };
  }

  const params: Record<string, unknown> = {
    auId: au.id, moveOn: au.moveOn, verbId: { select: ["event", "verbId"] },
  };
  if (au.masteryScore != null) params.masteryScore = au.masteryScore;

  return {
    initial: "unsatisfied",
    states: {
      unsatisfied: {
        durable: true,
        on: {
          VERB_RECEIVED: [
            { target: "satisfied", guard: { type: "verbSatisfiesAU", params }, actions: { type: "satisfyAU", params } },
            { guard: { type: "verbUpdatesAU", params }, actions: { type: "updateAU", params } },
          ],
          WAIVED: {
            target: "satisfied",
            guard: { type: "waiveTargetsAU", params: { auId: au.id } },
            actions: { type: "waiveAU", params: { auId: au.id } },
          },
        },
      },
      satisfied: { type: "final" },
    },
  };
}

function buildSessionsRegion(): StateDefinition {
  return {
    initial: "idle",
    states: {
      idle: {
        durable: true,
        on: {
          LAUNCH_SESSION: { actions: "handleSessionLaunch" },
          FETCH_TOKEN_RETRIEVED: { actions: "handleFetchTokenRetrieved" },
          INITIALIZED: { target: "active", actions: "handleInitialized" },
        },
      },
      active: {
        durable: true,
        after: { "28800000": { target: "idle", actions: "handleSessionTimeout" } },
        on: {
          TERMINATED: { target: "idle", actions: "handleTerminated" },
          ANSWERED: { target: "active", actions: "handleAnswered" },
          VERB_RECEIVED: { target: "active" },
          LAUNCH_SESSION: { target: "idle", actions: "handleSessionLaunch" },
        },
      },
    },
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function doneEventName(machineId: string, ...path: string[]): string {
  return `xstate.done.state.${machineId}.${path.join(".")}`;
}
