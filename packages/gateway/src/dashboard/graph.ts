import type { SerializedMachine, SerializedStateNode } from "@durable-xstate/durable-machine";

/** A node in the graph layout input. */
export interface GraphNode {
  id: string;
  label: string;
  type: SerializedStateNode["type"];
  durable: boolean;
  hasPrompt: boolean;
  hasInvoke: boolean;
  hasEffects: boolean;
  parent: string | null;
  children: string[];
}

/** An edge in the graph layout input. */
export interface GraphEdge {
  source: string;
  target: string;
  label: string;
  type: "event" | "always" | "after" | "done" | "error";
}

/** Data structure embedded in HTML for client-side ELK rendering. */
export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  initial: string;
}

/**
 * Extracts a flat graph data structure from a serialized machine definition
 * for client-side ELK layout and SVG rendering.
 */
export function extractGraphData(definition: SerializedMachine): GraphData {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  for (const [path, state] of Object.entries(definition.states)) {
    // Determine parent from dot-path
    const dotIdx = path.lastIndexOf(".");
    const parent = dotIdx >= 0 ? path.substring(0, dotIdx) : null;

    nodes.push({
      id: path,
      label: path.includes(".") ? path.substring(path.lastIndexOf(".") + 1) : path,
      type: state.type,
      durable: state.durable === true,
      hasPrompt: state.prompt != null,
      hasInvoke: (state.invoke?.length ?? 0) > 0,
      hasEffects: (state.effects?.length ?? 0) > 0,
      parent,
      children: state.children ?? [],
    });

    // Event-driven transitions
    if (state.on) {
      for (const [eventType, transitions] of Object.entries(state.on)) {
        for (const t of transitions) {
          if (t.target) {
            const label = t.guard ? `${eventType} [${t.guard}]` : eventType;
            // Determine edge type based on event prefix
            const edgeType = eventType.startsWith("xstate.done.")
              ? "done" as const
              : eventType.startsWith("xstate.error.")
                ? "error" as const
                : "event" as const;
            edges.push({ source: path, target: t.target, label, type: edgeType });
          }
        }
      }
    }

    // Always (eventless) transitions
    if (state.always) {
      for (const t of state.always) {
        if (t.target) {
          const label = t.guard ? `[${t.guard}]` : "";
          edges.push({ source: path, target: t.target, label, type: "always" });
        }
      }
    }

    // After (delayed) transitions
    if (state.after) {
      for (const t of state.after) {
        if (t.target) {
          const delayLabel = typeof t.delay === "number"
            ? `${t.delay}ms`
            : String(t.delay);
          const label = t.guard ? `after ${delayLabel} [${t.guard}]` : `after ${delayLabel}`;
          edges.push({ source: path, target: t.target, label, type: "after" });
        }
      }
    }
  }

  return { nodes, edges, initial: definition.initial };
}
