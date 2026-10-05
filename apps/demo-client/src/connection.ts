import { ClientSession } from "@crdt/relay-worker/client";
import type { ClientMessage, ServerMessage } from "@crdt/relay-worker/protocol";

/** A ClientSession attached to a WebSocket (Node 22+ global), with manual drop / reconnect. */
export class Connection {
  readonly session: ClientSession;
  private ws: WebSocket | null = null;
  onChange: () => void = () => {};
  onStatus: (status: string) => void = () => {};

  constructor(
    private readonly baseUrl: string,
    private readonly docId: string,
    replicaId: string,
  ) {
    this.session = new ClientSession(replicaId);
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /** Resolves once the initial sync has completed. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${this.baseUrl}/doc/${this.docId}/ws?${this.session.connectQuery()}`);
      this.ws = ws;
      ws.addEventListener("message", (event) => {
        if (this.ws !== ws) return;
        const message = JSON.parse(String(event.data)) as ServerMessage;
        const result = this.session.receive(message);
        this.sendAll(result.send);
        if (result.error !== undefined) this.onStatus(`relay error: ${result.error}`);
        if (result.changed) this.onChange();
        if (message.type === "synced") {
          this.onStatus(`synced (seq ${message.seq}, epoch ${message.epoch})`);
          resolve();
        }
        if (result.reconnect) {
          this.onStatus("relay lost un-persisted ops; resyncing");
          this.drop();
          void this.connect();
        }
      });
      ws.addEventListener("close", (event) => {
        if (this.ws === ws) {
          this.ws = null;
          this.onStatus(`disconnected (${event.code})`);
        }
      });
      ws.addEventListener("error", () => reject(new Error(`could not connect to ${this.baseUrl}`)));
    });
  }

  /** Kills the connection without telling the session; edits keep accumulating locally. */
  drop(): void {
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000, "dropped");
  }

  insert(index: number, text: string): void {
    this.sendAll(this.session.insert(index, text));
    this.onChange();
  }

  delete(index: number, count = 1): void {
    this.sendAll(this.session.delete(index, count));
    this.onChange();
  }

  private sendAll(messages: ClientMessage[]): void {
    if (!this.connected) return;
    for (const message of messages) (this.ws as WebSocket).send(JSON.stringify(message));
  }
}

export function parseArgs(argv: readonly string[], defaults: Record<string, string>): Record<string, string> {
  const out = { ...defaults };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg.startsWith("--") && argv[i + 1] !== undefined) out[arg.slice(2)] = argv[++i] as string;
  }
  return out;
}
