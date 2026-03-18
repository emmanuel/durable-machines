import type {
  DurableStateSnapshot,
  StepInfo,
  EffectStatus,
  FormField,
  AggregateStateDuration,
  TransitionCountRow,
} from "@durable-machines/machine";
import type { GraphData } from "./graph.js";
import type { ActivityEntry } from "./activity-feed.js";

export interface LayoutOptions {
  title: string;
  basePath: string;
  breadcrumbs?: { label: string; href?: string }[];
  sseUrl?: string;
}

export interface MachineListItem {
  machineId: string;
  instanceCount: number;
  label?: string;
  description?: string;
  tags?: string[];
}

export interface InstanceDetailData {
  machineId: string;
  instanceId: string;
  snapshot: DurableStateSnapshot;
  steps: StepInfo[];
  graphData: GraphData;
  availableEvents: string[];
  eventSchemas?: Record<string, FormField[]>;
  effects?: EffectStatus[];
  activityFeed: ActivityEntry[];
  activeStates: string[];
  visitedStates: string[];
  activeSleep?: { stateId: string; delay: number; enteredAt: number; wakeAt: number } | null;
  /** Aggregate state durations across all instances of this machine. Present when analytics enabled. */
  aggregateStateDurations?: AggregateStateDuration[];
  /** Transition counts for this machine. Present when analytics enabled. */
  transitionCounts?: TransitionCountRow[];
  /** Graph layout direction. @defaultValue `"RIGHT"` */
  graphDirection?: "RIGHT" | "DOWN";
}
