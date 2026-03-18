import type { ItemRouter, ItemTransform } from "../types.js";
import type { Logger } from "@durable-machines/machine";

// Re-export Logger from durable-machine
export type { Logger };

/** Opaque cursor — transport defines the shape, checkpoint store serializes as JSON. */
export type StreamCursor = Record<string, unknown>;

/** A single message received from a stream transport. */
export interface StreamMessage<TRaw> {
  /** Protocol-native message data. */
  raw: TRaw;
  /** Opaque cursor representing this message's position in the stream. */
  cursor: StreamCursor;
}

/** Protocol-specific stream transport. */
export interface StreamTransport<TRaw> {
  /** Connect and yield messages. Handles reconnection internally. */
  consume(
    cursor: StreamCursor | null,
    signal: AbortSignal,
  ): AsyncIterable<StreamMessage<TRaw>>;
  /** Signal successful processing of a message (offset commit, SQS delete, etc). */
  acknowledge(msg: StreamMessage<TRaw>): Promise<void>;
  /** Close the connection. */
  close(): Promise<void>;
}

/** Persists stream cursors across restarts. */
export interface CheckpointStore {
  load(streamId: string): Promise<StreamCursor | null>;
  save(streamId: string, cursor: StreamCursor): Promise<void>;
}

/** Full configuration for a stream consumer. */
export interface StreamBinding<TRaw, TItem> {
  /** Unique identifier for this consumer (used as checkpoint key). */
  streamId: string;
  transport: StreamTransport<TRaw>;
  /** Parse a raw message into zero or more items. Zero = skip (heartbeat). */
  parse(msg: TRaw): TItem[];
  router: ItemRouter<TItem>;
  transform: ItemTransform<TItem>;
  /** Extract a dedup key from a stream item + cursor. Return undefined to skip dedup. */
  idempotencyKey?: (item: TItem, cursor: StreamCursor) => string | undefined;
}
