import type { Pool, Client as PgClient } from "pg";

export type ListenCallback = (machineName: string, instanceId: string, topic: string) => void;
export type TaskCallback = (instanceId: string) => void;

export interface ListenNotifyHandle {
  startListening(eventCallback: ListenCallback, taskCallback?: TaskCallback): Promise<void>;
  stopListening(): Promise<void>;
}

/**
 * Creates a dedicated LISTEN/NOTIFY client (not from the pool) with
 * automatic reconnect using exponential backoff.
 *
 * Listens on two channels:
 * - `machine_event`: fired when new events are inserted into event_log
 * - `effect_pending`: fired when new tasks are inserted into effect_outbox
 */
export function createListenNotify(pool: Pool, enabled: boolean): ListenNotifyHandle {
  let listenClient: PgClient | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let eventCb: ListenCallback | null = null;
  let taskCb: TaskCallback | null = null;
  let reconnectAttempt = 0;
  const MAX_RECONNECT_MS = 30_000;

  async function connectListener(): Promise<void> {
    if (stopped || !enabled) return;

    try {
      const pg = await import("pg");
      const Client = pg.default?.Client ?? pg.Client;
      const client = new Client(
        (pool as any).options ?? {
          connectionString: (pool as any)._connectionString,
        },
      );
      await client.connect();
      await client.query("LISTEN machine_event");
      await client.query("LISTEN effect_pending");
      reconnectAttempt = 0;

      listenClient = client as unknown as PgClient;

      client.on("notification", (msg: any) => {
        if (msg.channel === "machine_event" && msg.payload && eventCb) {
          const parts = msg.payload.split("::");
          if (parts.length < 2) return;
          const [machineName, instanceId, topic] = parts;
          if (!machineName || !instanceId) return;
          eventCb(machineName, instanceId, topic ?? "event");
        } else if (msg.channel === "effect_pending" && msg.payload && taskCb) {
          taskCb(msg.payload);
        }
      });

      client.on("error", () => { reconnect(); });
      client.on("end", () => { if (!stopped) reconnect(); });
    } catch {
      reconnect();
    }
  }

  function reconnect(): void {
    if (stopped) return;
    if (listenClient) {
      (listenClient as any).end().catch(() => {});
      listenClient = null;
    }
    if (reconnectTimer) clearTimeout(reconnectTimer);
    const delay = Math.min(1000 * 2 ** reconnectAttempt, MAX_RECONNECT_MS);
    reconnectAttempt++;
    reconnectTimer = setTimeout(() => { void connectListener(); }, delay);
  }

  return {
    async startListening(eventCallback: ListenCallback, taskCallback?: TaskCallback): Promise<void> {
      eventCb = eventCallback;
      taskCb = taskCallback ?? null;
      if (enabled) await connectListener();
    },

    async stopListening(): Promise<void> {
      stopped = true;
      eventCb = null;
      taskCb = null;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (listenClient) {
        await (listenClient as any).end().catch(() => {});
        listenClient = null;
      }
    },
  };
}
