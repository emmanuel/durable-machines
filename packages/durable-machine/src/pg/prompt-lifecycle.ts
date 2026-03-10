import type { AnyMachineSnapshot, AnyEventObject } from "xstate";
import type { ChannelAdapter, PromptConfig } from "../types.js";
import { getPromptConfig } from "../prompt.js";
import type { PgStore } from "./store-types.js";

export function getSnapshotPromptConfig(
  snapshot: AnyMachineSnapshot,
): PromptConfig | null {
  for (const node of snapshot._nodes) {
    const config = getPromptConfig(node.meta);
    if (config) return config;
  }
  return null;
}

export async function handlePromptEntry(
  store: PgStore,
  instanceId: string,
  snapshot: AnyMachineSnapshot,
  channels: ChannelAdapter[],
): Promise<void> {
  const promptConfig = getSnapshotPromptConfig(snapshot);
  if (!promptConfig || channels.length === 0) return;

  const stepKey = `prompt:${JSON.stringify(snapshot.value)}`;

  const cached = await store.getInvokeResult(instanceId, stepKey);
  if (cached) return;

  const handles: unknown[] = [];
  for (const ch of channels) {
    const { handle } = await ch.sendPrompt({
      workflowId: instanceId,
      stateValue: snapshot.value,
      prompt: promptConfig,
      context: snapshot.context as Record<string, unknown>,
    });
    handles.push(handle);
  }

  await store.recordInvokeResult({
    instanceId,
    stepKey,
    output: handles,
    startedAt: Date.now(),
    completedAt: Date.now(),
  });
}

export async function handlePromptExit(
  store: PgStore,
  instanceId: string,
  prevStateValue: unknown,
  newSnapshot: AnyMachineSnapshot,
  channels: ChannelAdapter[],
  event: AnyEventObject,
): Promise<void> {
  if (channels.length === 0) return;

  const stepKey = `prompt:${JSON.stringify(prevStateValue)}`;
  const cached = await store.getInvokeResult(instanceId, stepKey);
  if (!cached) return;

  const handles = cached.output as unknown[];

  const resolveKey = `resolve-prompt:${JSON.stringify(prevStateValue)}`;
  const resolved = await store.getInvokeResult(instanceId, resolveKey);
  if (resolved) return;

  for (let i = 0; i < channels.length; i++) {
    await channels[i].resolvePrompt?.({
      handle: handles?.[i],
      event,
      newStateValue: newSnapshot.value,
    });
  }

  await store.recordInvokeResult({
    instanceId,
    stepKey: resolveKey,
    output: true,
    startedAt: Date.now(),
    completedAt: Date.now(),
  });
}
