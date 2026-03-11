import type { Pool, Client as PgClient } from "pg";

export type ListenCallback = (machineName: string, instanceId: string, topic: string) => void;

export interface ListenNotifyHandle {
  startListening(callback: ListenCallback): Promise<void>;
  stopListening(): Promise<void>;
}

/**
 * Creates a dedicated LISTEN/NOTIFY client (not from the pool) with
 * automatic reconnect using exponential backoff.
 */
export function createListenNotify(pool: Pool, enabled: boolean): ListenNotifyHandle {
  let listenClient: PgClient | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let listenCallback: ListenCallback | null = null;
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
      reconnectAttempt = 0;

      listenClient = client as unknown as PgClient;

      client.on("notification", (msg: any) => {
        if (msg.channel === "machine_event" && msg.payload && listenCallback) {
          const parts = msg.payload.split("::");
          if (parts.length < 2) return;
          const [machineName, instanceId, topic] = parts;
          if (!machineName || !instanceId) return;
          listenCallback(machineName, instanceId, topic ?? "event");
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
    async startListening(callback: ListenCallback): Promise<void> {
      listenCallback = callback;
      if (enabled) await connectListener();
    },

    async stopListening(): Promise<void> {
      stopped = true;
      listenCallback = null;
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
