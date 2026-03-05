import type { GatewayClient, RouteResult } from "../types.js";
import type { GatewayMetrics } from "../metrics.js";
import type { CheckpointStore, Logger, StreamBinding, StreamCursor } from "./types.js";

export interface StreamConsumerOptions {
  client: GatewayClient;
  checkpoints: CheckpointStore;
  logger: Logger;
  /** How often to checkpoint (message count). Default: 100. */
  checkpointInterval?: number;
  /** Optional metrics instance. */
  metrics?: GatewayMetrics;
}

export interface StreamConsumerHandle {
  /** Resolves when the consumer is fully stopped. */
  stopped: Promise<void>;
  /** Signal the consumer to stop gracefully. */
  stop(): void;
}

export function startStreamConsumer<TRaw, TItem>(
  binding: StreamBinding<TRaw, TItem>,
  options: StreamConsumerOptions,
): StreamConsumerHandle {
  const {
    client,
    checkpoints,
    logger,
    checkpointInterval = 100,
    metrics,
  } = options;

  const controller = new AbortController();
  const { signal } = controller;

  const stopped = run(
    binding,
    client,
    checkpoints,
    logger,
    checkpointInterval,
    metrics,
    signal,
  );

  return {
    stopped,
    stop() {
      controller.abort();
    },
  };
}

/** Normalize a RouteResult to an array of workflow IDs (empty array for null/undefined). */
function normalizeRouteResult(result: RouteResult): string[] {
  if (result == null) return [];
  return Array.isArray(result) ? result : [result];
}

async function run<TRaw, TItem>(
  binding: StreamBinding<TRaw, TItem>,
  client: GatewayClient,
  checkpoints: CheckpointStore,
  logger: Logger,
  checkpointInterval: number,
  metrics: GatewayMetrics | undefined,
  signal: AbortSignal,
): Promise<void> {
  const { streamId, transport, parse, router, transform } = binding;

  logger.info({ streamId }, "Stream consumer starting");

  let cursor: StreamCursor | null;
  try {
    cursor = await checkpoints.load(streamId);
  } catch (err: unknown) {
    logger.error(
      { streamId, err: err instanceof Error ? err.message : String(err) },
      "Failed to load checkpoint, starting from beginning",
    );
    cursor = null;
  }

  let latestCursor: StreamCursor | null = cursor;
  let messageCount = 0;

  try {
    for await (const msg of transport.consume(cursor, signal)) {
      if (signal.aborted) break;

      metrics?.streamEventsReceived?.inc({ streamId });

      const items = parse(msg.raw);
      if (items.length === 0) {
        // Heartbeat or empty message — acknowledge but don't count toward checkpoint interval
        await transport.acknowledge(msg);
        latestCursor = msg.cursor;
        continue;
      }

      for (const item of items) {
        const routeResult = await router.route(item);
        const ids = normalizeRouteResult(routeResult);
        if (ids.length === 0) continue;

        const event = transform.transform(item);
        for (const workflowId of ids) {
          try {
            await client.send(workflowId, event, "xstate.event");
            metrics?.streamItemsDispatched?.inc({ streamId });
          } catch (err: unknown) {
            logger.error(
              {
                streamId,
                workflowId,
                err: err instanceof Error ? err.message : String(err),
              },
              "Failed to dispatch item, continuing",
            );
          }
        }
      }

      await transport.acknowledge(msg);
      latestCursor = msg.cursor;
      messageCount++;

      if (messageCount % checkpointInterval === 0) {
        await checkpoints.save(streamId, latestCursor);
        metrics?.streamCheckpoints?.inc({ streamId });
      }
    }
  } catch (err: unknown) {
    if (!signal.aborted) {
      logger.error(
        { streamId, err: err instanceof Error ? err.message : String(err) },
        "Stream consumer error",
      );
    }
  } finally {
    // Save final checkpoint
    if (latestCursor) {
      try {
        await checkpoints.save(streamId, latestCursor);
        metrics?.streamCheckpoints?.inc({ streamId });
        logger.info({ streamId }, "Final checkpoint saved");
      } catch (err: unknown) {
        logger.error(
          { streamId, err: err instanceof Error ? err.message : String(err) },
          "Failed to save final checkpoint",
        );
      }
    }

    await transport.close();
    logger.info({ streamId }, "Stream consumer stopped");
  }
}
