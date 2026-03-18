import type { AnyActorLogic } from "xstate";
import { httpActor } from "../actors/http.js";

/** A frozen collection of named implementations for use with JSON machine definitions. */
export interface ImplementationRegistry {
  readonly id: string;
  readonly actors: Readonly<Record<string, AnyActorLogic>>;
  readonly guards: Readonly<Record<string, (...args: any[]) => boolean>>;
  readonly actions: Readonly<Record<string, (...args: any[]) => void>>;
  readonly delays: Readonly<Record<string, ((...args: any[]) => number) | number>>;
}

/**
 * Creates a frozen implementation registry from named implementations.
 *
 * Omitted categories default to empty objects. The returned registry
 * and all its records are `Object.freeze`d.
 */
export function createImplementationRegistry(config: {
  id: string;
  actors?: Record<string, AnyActorLogic>;
  guards?: Record<string, (...args: any[]) => boolean>;
  actions?: Record<string, (...args: any[]) => void>;
  delays?: Record<string, ((...args: any[]) => number) | number>;
}): ImplementationRegistry {
  return Object.freeze({
    id: config.id,
    actors: Object.freeze({ http: httpActor, ...config.actors }),
    guards: Object.freeze({ ...config.guards }),
    actions: Object.freeze({ ...config.actions }),
    delays: Object.freeze({ ...config.delays }),
  });
}
