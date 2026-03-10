import type {
  DurableStateSnapshot,
  StepInfo,
  EffectStatus,
  EventLogEntry,
  TransitionRecord,
  StateDuration,
  FormField,
} from "@durable-xstate/durable-machine";
import type { GraphData } from "./graph.js";

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
  transitions: TransitionRecord[];
  stateDurations: StateDuration[];
  availableEvents: string[];
  eventSchemas?: Record<string, FormField[]>;
  effects?: EffectStatus[];
  eventLog?: EventLogEntry[];
  activeStates: string[];
  visitedStates: string[];
  activeSleep?: { stateId: string; delay: number; enteredAt: number; wakeAt: number } | null;
}
