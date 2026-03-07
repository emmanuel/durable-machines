# DBOS Common Patterns

## Table of Contents

1. [Background Task with Status Polling](#background-task-with-status-polling)
2. [Human-in-the-Loop (Approval)](#human-in-the-loop-approval)
3. [Fan-Out / Fan-In](#fan-out--fan-in)
4. [Idempotent Workflow Start](#idempotent-workflow-start)
5. [Scheduled Periodic Job](#scheduled-periodic-job)
6. [Retry with Fallback](#retry-with-fallback)
7. [Saga / Compensation](#saga--compensation)
8. [Data Pipeline](#data-pipeline)
9. [Event-Driven Workflow Chain](#event-driven-workflow-chain)
10. [Streaming Progress Updates](#streaming-progress-updates)
11. [Webhook Handler](#webhook-handler)
12. [Rate-Limited External API Calls](#rate-limited-external-api-calls)
13. [Cross-Service Communication](#cross-service-communication)
14. [Long-Running Process with Heartbeat](#long-running-process-with-heartbeat)

---

## Background Task with Status Polling

Start a workflow in the background with a custom ID. Poll for status from an API endpoint.

```ts
// Start with deterministic ID
const handle = await DBOS.startWorkflow(processData, {
  workflowID: `job-${jobId}`,
})(data);

// From an Express route — poll status
app.get('/api/jobs/:id/status', async (req, res) => {
  const status = await DBOS.getWorkflowStatus(`job-${req.params.id}`);
  if (!status) return res.status(404).json({ error: 'Not found' });
  res.json({
    status: status.status,
    output: status.output,
    createdAt: status.createdAt,
  });
});

// Or read published events for richer state
app.get('/api/jobs/:id/progress', async (req, res) => {
  const progress = await DBOS.getEvent(`job-${req.params.id}`, "progress", 0);
  res.json({ progress: progress ?? { percent: 0, stage: 'queued' } });
});

// Inside the workflow — publish progress
async function processDataFn(data: InputData) {
  await DBOS.setEvent("progress", { percent: 0, stage: 'starting' });

  const parsed = await DBOS.runStep(() => parseInput(data), { name: "parse" });
  await DBOS.setEvent("progress", { percent: 25, stage: 'parsed' });

  const enriched = await DBOS.runStep(() => enrichData(parsed), { name: "enrich" });
  await DBOS.setEvent("progress", { percent: 50, stage: 'enriched' });

  const result = await DBOS.runStep(() => saveResults(enriched), { name: "save" });
  await DBOS.setEvent("progress", { percent: 100, stage: 'complete' });

  return result;
}
const processData = DBOS.registerWorkflow(processDataFn, { name: "processData" });
```

---

## Human-in-the-Loop (Approval)

Use `DBOS.recv()` to durably wait for external input. The workflow survives restarts.

```ts
async function approvalWorkflowFn(requestId: string, reviewerId: string) {
  // Notify the reviewer (via step for durability)
  await DBOS.runStep(
    () => sendSlackMessage(reviewerId, `Please review request ${requestId}`),
    { name: "notifyReviewer" }
  );

  // Publish status for external polling
  await DBOS.setEvent("status", { state: "pending_approval", reviewerId });

  // Wait up to 72 hours for a response
  const response = await DBOS.recv<{ decision: string; comment?: string }>(
    "approval",
    259200 // 72 hours in seconds
  );

  if (!response || response.decision === "reject") {
    await DBOS.setEvent("status", { state: "rejected", comment: response?.comment });
    await DBOS.runStep(
      () => notifyRejection(requestId),
      { name: "notifyRejection" }
    );
    return { approved: false };
  }

  await DBOS.setEvent("status", { state: "approved" });
  await DBOS.runStep(
    () => processApproval(requestId),
    { name: "processApproval" }
  );
  return { approved: true };
}
const approvalWorkflow = DBOS.registerWorkflow(approvalWorkflowFn, { name: "approval" });

// External system sends the decision (from webhook, API route, etc.)
await DBOS.send(workflowId, { decision: "approve", comment: "Looks good" }, "approval");

// Or from outside the DBOS runtime via DBOSClient
const client = await DBOSClient.create({ systemDatabaseUrl: "..." });
await client.send(workflowId, { decision: "approve" }, "approval");
```

---

## Fan-Out / Fan-In

Process many items concurrently using queues, then collect results.

```ts
const processingQueue = new WorkflowQueue("processing", {
  workerConcurrency: 10,
  concurrency: 50,
});

async function batchProcessorFn(items: Item[]) {
  // Fan out: enqueue a child workflow per item
  const handles = [];
  for (const item of items) {
    const handle = await DBOS.startWorkflow(processItem, {
      queueName: processingQueue.name,
    })(item);
    handles.push(handle);
  }

  // Fan in: wait for all to complete
  const results = [];
  for (const handle of handles) {
    results.push(await handle.getResult());
  }

  // Aggregate
  const summary = await DBOS.runStep(
    () => aggregateResults(results),
    { name: "aggregate" }
  );
  return summary;
}
const batchProcessor = DBOS.registerWorkflow(batchProcessorFn, { name: "batchProcessor" });

async function processItemFn(item: Item) {
  const enriched = await DBOS.runStep(
    () => enrichItem(item),
    { name: "enrich", retriesAllowed: true, maxAttempts: 3 }
  );
  const saved = await DBOS.runStep(
    () => saveItem(enriched),
    { name: "save" }
  );
  return saved;
}
const processItem = DBOS.registerWorkflow(processItemFn, { name: "processItem" });
```

---

## Idempotent Workflow Start

Starting a workflow with the same ID is idempotent. This is useful for ensuring exactly-once processing from webhooks or retry-prone callers.

```ts
// From an Express webhook handler:
app.post('/webhooks/stripe', async (req, res) => {
  const event = req.body;

  // Use the Stripe event ID as the workflow ID
  // If this webhook fires twice, the second call returns the existing workflow
  const handle = await DBOS.startWorkflow(handleStripeEvent, {
    workflowID: `stripe-${event.id}`,
  })(event);

  res.status(200).json({ workflowId: handle.workflowID });
});
```

**Behavior:**
- If workflow doesn't exist → starts normally.
- If workflow is currently running → returns handle to existing execution.
- If workflow already completed → returns the previous result.

---

## Scheduled Periodic Job

```ts
class MaintenanceJobs {
  @DBOS.workflow()
  @DBOS.scheduled({
    crontab: "0 2 * * *",  // Daily at 2 AM
    mode: SchedulerMode.ExactlyOncePerIntervalWhenActive,
  })
  static async dailyCleanup(scheduledTime: Date, startTime: Date) {
    DBOS.logger.info(`Running cleanup scheduled for ${scheduledTime.toISOString()}`);

    const staleRecords = await DBOS.runStep(
      () => findStaleRecords(),
      { name: "findStale" }
    );

    for (const record of staleRecords) {
      await DBOS.runStep(
        () => archiveRecord(record),
        { name: `archive-${record.id}` }
      );
    }

    DBOS.logger.info(`Archived ${staleRecords.length} records`);
  }
}
```

**Modes:**
- `ExactlyOncePerIntervalWhenActive` (default): Only runs scheduled intervals while the app is running.
- `ExactlyOncePerInterval`: Also retroactively runs missed intervals from downtime.

---

## Retry with Fallback

Steps handle retries automatically. Add workflow-level fallback logic for when all retries are exhausted.

```ts
async function resilientProcessFn(input: string) {
  try {
    // Primary path: retry up to 5 times
    return await DBOS.runStep(
      () => callPrimaryService(input),
      { name: "primary", retriesAllowed: true, maxAttempts: 5, intervalSeconds: 2, backoffRate: 2 }
    );
  } catch (primaryError) {
    // Fallback path
    DBOS.logger.warn(`Primary failed after retries, trying fallback: ${primaryError}`);

    try {
      return await DBOS.runStep(
        () => callFallbackService(input),
        { name: "fallback", retriesAllowed: true, maxAttempts: 3 }
      );
    } catch (fallbackError) {
      // Both failed — record failure and notify
      await DBOS.runStep(
        () => notifyOnCallTeam(input, primaryError, fallbackError),
        { name: "notifyFailure" }
      );
      throw fallbackError; // Terminates workflow with ERROR
    }
  }
}
const resilientProcess = DBOS.registerWorkflow(resilientProcessFn, { name: "resilientProcess" });
```

---

## Saga / Compensation

Execute a sequence of steps. If any step fails, run compensating actions in reverse order.

```ts
async function bookTripFn(trip: TripRequest) {
  const compensations: Array<() => Promise<void>> = [];

  try {
    // Step 1: Book flight
    const flight = await DBOS.runStep(
      () => bookFlight(trip.flight),
      { name: "bookFlight", retriesAllowed: true }
    );
    compensations.push(() => cancelFlight(flight.id));

    // Step 2: Book hotel
    const hotel = await DBOS.runStep(
      () => bookHotel(trip.hotel),
      { name: "bookHotel", retriesAllowed: true }
    );
    compensations.push(() => cancelHotel(hotel.id));

    // Step 3: Book car
    const car = await DBOS.runStep(
      () => bookCar(trip.car),
      { name: "bookCar", retriesAllowed: true }
    );
    compensations.push(() => cancelCar(car.id));

    return { flight, hotel, car };
  } catch (error) {
    // Compensate in reverse order
    DBOS.logger.warn(`Trip booking failed, compensating: ${error}`);
    for (let i = compensations.length - 1; i >= 0; i--) {
      await DBOS.runStep(
        compensations[i],
        { name: `compensate-${i}`, retriesAllowed: true }
      );
    }
    throw error;
  }
}
const bookTrip = DBOS.registerWorkflow(bookTripFn, { name: "bookTrip" });
```

---

## Data Pipeline

Process a large dataset in chunks with checkpointed progress.

```ts
async function dataPipelineFn(sourceUrl: string) {
  // Step 1: Discover chunks
  const chunks = await DBOS.runStep(
    () => listDataChunks(sourceUrl),
    { name: "discoverChunks" }
  );

  await DBOS.setEvent("progress", { total: chunks.length, completed: 0 });

  // Step 2: Process each chunk (each is a separate checkpointed step)
  const results = [];
  for (let i = 0; i < chunks.length; i++) {
    const result = await DBOS.runStep(
      () => processChunk(chunks[i]),
      { name: `processChunk-${i}`, retriesAllowed: true, maxAttempts: 3 }
    );
    results.push(result);
    await DBOS.setEvent("progress", { total: chunks.length, completed: i + 1 });
  }

  // Step 3: Finalize
  const summary = await DBOS.runStep(
    () => finalizePipeline(results),
    { name: "finalize" }
  );

  return summary;
}
const dataPipeline = DBOS.registerWorkflow(dataPipelineFn, { name: "dataPipeline" });
```

If the process crashes at chunk 47 out of 100, on restart it instantly replays chunks 0–46 from cache and resumes processing from chunk 47.

---

## Event-Driven Workflow Chain

One workflow triggers the next via messages or child workflows.

```ts
// Parent orchestrates child workflows
async function orderPipelineFn(order: Order) {
  // Phase 1: Validate
  const validateHandle = await DBOS.startWorkflow(validateOrder)(order);
  const validated = await validateHandle.getResult();
  if (!validated.ok) return { status: "rejected", reason: validated.reason };

  // Phase 2: Process payment
  const paymentHandle = await DBOS.startWorkflow(processPayment)(order.payment);
  const payment = await paymentHandle.getResult();

  // Phase 3: Fulfill
  const fulfillHandle = await DBOS.startWorkflow(fulfillOrder)(order, payment);
  const fulfillment = await fulfillHandle.getResult();

  return { status: "complete", fulfillment };
}
const orderPipeline = DBOS.registerWorkflow(orderPipelineFn, { name: "orderPipeline" });
```

---

## Streaming Progress Updates

Use streams for real-time ordered output from a workflow.

```ts
async function analysisWorkflowFn(input: AnalysisInput) {
  const chunks = await DBOS.runStep(() => splitInput(input), { name: "split" });

  for (const chunk of chunks) {
    const result = await DBOS.runStep(() => analyzeChunk(chunk), { name: `analyze-${chunk.id}` });
    await DBOS.writeStream("results", result); // Stream each result as it completes
  }

  await DBOS.closeStream("results");
  return { totalChunks: chunks.length };
}
const analysisWorkflow = DBOS.registerWorkflow(analysisWorkflowFn, { name: "analysis" });

// Consumer reads in real-time
const handle = await DBOS.startWorkflow(analysisWorkflow)(input);
for await (const result of DBOS.readStream(handle.workflowID, "results")) {
  console.log("Got result:", result);
}
```

---

## Webhook Handler

Use DBOSClient from a webhook endpoint to interact with DBOS workflows without running the full DBOS runtime.

```ts
import express from 'express';
import { DBOSClient } from '@dbos-inc/dbos-sdk';

const app = express();
const client = await DBOSClient.create({
  systemDatabaseUrl: process.env.DBOS_SYSTEM_DATABASE_URL!,
});

// Enqueue work from a webhook
app.post('/webhooks/github', async (req, res) => {
  const event = req.body;
  const handle = await client.enqueue(
    { workflowName: "handleGithubEvent", queueName: "github" },
    event,
  );
  res.json({ workflowId: handle.workflowID });
});

// Send a decision to a waiting workflow
app.post('/api/approve/:workflowId', async (req, res) => {
  await client.send(req.params.workflowId, req.body, "approval");
  res.json({ ok: true });
});
```

---

## Rate-Limited External API Calls

Use queues to rate-limit calls to external APIs.

```ts
const apiQueue = new WorkflowQueue("external-api", {
  workerConcurrency: 2,                    // Max 2 concurrent per process
  rateLimit: { limitPerPeriod: 10, periodSec: 1 }, // Max 10 per second
});

async function callApiFn(request: ApiRequest) {
  return await DBOS.runStep(
    () => fetch(request.url, request.options).then(r => r.json()),
    { name: "apiCall", retriesAllowed: true, maxAttempts: 3 }
  );
}
const callApi = DBOS.registerWorkflow(callApiFn, { name: "callApi" });

// Enqueue many — they'll be rate-limited automatically
for (const req of requests) {
  await DBOS.startWorkflow(callApi, { queueName: apiQueue.name })(req);
}
```

---

## Cross-Service Communication

Use DBOSClient to interact between separate DBOS applications (each with their own system database).

```ts
// Service A: API server
// Service B: Processing service (separate app, separate system DB)

// In Service A — enqueue work on Service B
const processingClient = await DBOSClient.create({
  systemDatabaseUrl: process.env.SERVICE_B_SYSTEM_DB_URL!,
});

const handle = await processingClient.enqueue(
  { workflowName: "processData", queueName: "incoming" },
  data,
);

// Poll for result
const status = await processingClient.getWorkflowStatus(handle.workflowID);
if (status?.status === 'SUCCESS') {
  console.log("Result:", status.output);
}
```

---

## Long-Running Process with Heartbeat

Publish periodic heartbeats so external systems can detect stalled workflows.

```ts
async function longRunningProcessFn(taskId: string) {
  const items = await DBOS.runStep(() => loadItems(taskId), { name: "load" });

  for (let i = 0; i < items.length; i++) {
    await DBOS.runStep(() => processItem(items[i]), { name: `process-${i}` });

    // Heartbeat: update event with latest progress and timestamp
    await DBOS.setEvent("heartbeat", {
      lastStep: i,
      totalSteps: items.length,
      timestamp: Date.now(),
    });
  }

  return { processedCount: items.length };
}
const longRunningProcess = DBOS.registerWorkflow(longRunningProcessFn, {
  name: "longRunning",
  maxRecoveryAttempts: 5,  // Dead letter after 5 crashes
});

// External monitor checks heartbeat
async function checkHealth(workflowId: string) {
  const heartbeat = await DBOS.getEvent(workflowId, "heartbeat", 0);
  if (heartbeat && Date.now() - heartbeat.timestamp > 300000) {
    console.warn("Workflow appears stalled!");
  }
}
```
