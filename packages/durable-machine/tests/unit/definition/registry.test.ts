import { describe, it, expect } from "vitest";
import { fromPromise } from "xstate";
import { createImplementationRegistry } from "../../../src/definition/registry.js";

describe("createImplementationRegistry", () => {
  it("creates registry with actors, guards, actions, delays", () => {
    const actor = fromPromise(async () => ({ result: true }));
    const guard = () => true;
    const action = () => {};
    const delay = 1000;

    const registry = createImplementationRegistry({
      id: "test-v1",
      actors: { myActor: actor },
      guards: { myGuard: guard },
      actions: { myAction: action },
      delays: { myDelay: delay },
    });

    expect(registry.id).toBe("test-v1");
    expect(registry.actors.myActor).toBe(actor);
    expect(registry.guards.myGuard).toBe(guard);
    expect(registry.actions.myAction).toBe(action);
    expect(registry.delays.myDelay).toBe(1000);
  });

  it("defaults omitted categories to empty objects", () => {
    const registry = createImplementationRegistry({ id: "empty" });

    expect(registry.actors).toEqual({});
    expect(registry.guards).toEqual({});
    expect(registry.actions).toEqual({});
    expect(registry.delays).toEqual({});
  });

  it("is frozen — mutations throw in strict mode", () => {
    const registry = createImplementationRegistry({ id: "frozen" });

    expect(() => {
      (registry as any).id = "changed";
    }).toThrow();

    expect(() => {
      (registry.actors as any).newActor = {};
    }).toThrow();

    expect(() => {
      (registry.guards as any).newGuard = () => true;
    }).toThrow();
  });

  it("registry.id matches the provided id", () => {
    const registry = createImplementationRegistry({ id: "my-registry" });
    expect(registry.id).toBe("my-registry");
  });
});
