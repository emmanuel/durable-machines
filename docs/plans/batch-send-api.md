# Plan: Batch Send API for Multi-Target Dispatch

## Status: Done

## Problem

Every `client.send(workflowId, event, topic)` call is a separate DB write. In the webhook gateway's `dispatchItems`, a single webhook that fans out to N workflows produces N independent writes:

```typescript
// gateway.ts — current
for (const id of ids) {
  sends.push(client.send(id, event, "xstate.event"));
}
await Promise.all(sends);  // N parallel writes, but N separate transactions
```

The stream consumer has the same pattern. For high fan-out scenarios (broadcast to 100 workflows, xAPI batch with 50 statements), this creates significant DB write pressure.

## Proposed Change

### 1. Add `sendBatch` to `GatewayClient` interface (`types.ts`)

```typescript
export interface GatewayClient {
  send<T>(workflowId: string, message: T, topic: string): Promise<void>;
  /** Sends multiple messages in a single DB roundtrip. */
  sendBatch?<T>(messages: Array<{ workflowId: string; message: T; topic: string }>): Promise<void>;
  getEvent<T>(workflowId: string, key: string, timeoutSeconds?: number): Promise<T | null>;
}
```

Optional method — falls back to individual `send()` calls when not available.

### 2. Add `sendMachineEventBatch` to durable-state-machine client (`client.ts`)

```typescript
export async function sendMachineEventBatch(
  client: DBOSClient,
  events: Array<{ workflowId: string; event: AnyEventObject }>,
): Promise<void> {
  // If DBOSClient supports batch: use it
  // Otherwise: Promise.all(events.map(e => client.send(...)))
}
```

### 3. Update `dispatchItems` in gateway to use batch when available

Collect all `(workflowId, event, topic)` tuples, then call `sendBatch` once instead of N individual sends.

### 4. Update stream consumer similarly

## Depends On

- **DBOS SDK**: Need to verify whether `DBOSClient` supports (or could support) multi-row inserts into the message queue in a single transaction. If not, this plan requires an upstream SDK change or a raw SQL path.

## Impact

- N:1 reduction in DB roundtrips for fan-out dispatch
- Single transaction = atomicity (all-or-nothing delivery)
- Gateway latency drops proportionally for high fan-out webhooks

## Risks

- If DBOS doesn't expose batch send, the fallback (`Promise.all` of individual sends) is what we already do — no regression
- Batch size limits may need capping (e.g. 1000 per batch) to avoid oversized transactions
