/**
 * One accepted WebSocket client of the FakeT3Server: runs the envelope
 * protocol for that socket and records every envelope in both directions.
 */
import type { WebSocket } from "ws";
import type { FakeRpcResponse, FakeT3Server } from "./fake-server.js";

export type LoggedEnvelope = {
  readonly direction: "in" | "out";
  readonly envelope: Record<string, unknown>;
};

const envelopeRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : { _tag: "Invalid", raw: value };

export class FakeConnection {
  readonly log: LoggedEnvelope[] = [];
  readonly acks: string[] = [];
  readonly interrupts: string[] = [];
  pings = 0;
  answerPings = true;
  readonly #socket: WebSocket;
  readonly #server: FakeT3Server;
  readonly #ackWaiters = new Map<string, () => void>();
  readonly #interrupted = new Set<string>();

  constructor(socket: WebSocket, server: FakeT3Server) {
    this.#socket = socket;
    this.#server = server;
    socket.on("message", (data) => void this.#onMessage(String(data)));
  }

  /** Envelopes sent to the client, in order. */
  get sent(): Record<string, unknown>[] {
    return this.log.filter((e) => e.direction === "out").map((e) => e.envelope);
  }

  /** Envelopes received from the client, in order. */
  get received(): Record<string, unknown>[] {
    return this.log.filter((e) => e.direction === "in").map((e) => e.envelope);
  }

  send(envelope: Record<string, unknown>): void {
    this.log.push({ direction: "out", envelope });
    if (this.#socket.readyState === this.#socket.OPEN) this.#socket.send(JSON.stringify(envelope));
  }

  /** Sends one frame containing several envelopes, like the server's batching. */
  sendBatch(envelopes: Record<string, unknown>[]): void {
    for (const envelope of envelopes) this.log.push({ direction: "out", envelope });
    this.#socket.send(JSON.stringify(envelopes));
  }

  sendRaw(text: string): void {
    this.#socket.send(text);
  }

  /** Drops the TCP connection without a close handshake. */
  drop(): void {
    this.#socket.terminate();
  }

  close(code = 1000, reason = ""): void {
    this.#socket.close(code, reason);
  }

  async #onMessage(text: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.send({ _tag: "Defect", defect: "invalid json" });
      return;
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) await this.#onEnvelope(envelopeRecord(item));
  }

  async #onEnvelope(envelope: Record<string, unknown>): Promise<void> {
    this.log.push({ direction: "in", envelope });
    switch (envelope["_tag"]) {
      case "Ping":
        this.pings += 1;
        this.#server.pings += 1;
        if (this.answerPings) this.send({ _tag: "Pong" });
        return;
      case "Ack": {
        const id = String(envelope["requestId"]);
        this.acks.push(id);
        this.#ackWaiters.get(id)?.();
        return;
      }
      case "Interrupt": {
        const id = String(envelope["requestId"]);
        this.interrupts.push(id);
        this.#interrupted.add(id);
        this.#ackWaiters.get(id)?.();
        return;
      }
      case "Request":
        return this.#onRequest(envelope);
      case "Eof":
        return;
      default:
        this.send({ _tag: "Defect", defect: `Unknown request tag: ${String(envelope["_tag"])}` });
    }
  }

  async #onRequest(envelope: Record<string, unknown>): Promise<void> {
    const id = String(envelope["id"]);
    const tag = String(envelope["tag"]);
    if (!Array.isArray(envelope["headers"])) {
      this.#socket.close();
      return;
    }
    const handler = this.#server.handlers.get(tag);
    if (!handler) return this.#exit(id, { kind: "die", defect: `Unknown request tag: ${tag}` });
    const response = await handler(envelope["payload"], { requestId: id, connection: this });
    if (response.kind === "hang") return;
    if (response.kind !== "stream") return this.#exit(id, response);
    for (const values of response.chunks) {
      if (this.#interrupted.has(id)) break;
      const acked = this.#server.requireAck ? this.#waitForAck(id) : Promise.resolve();
      this.send({ _tag: "Chunk", requestId: id, values });
      await acked;
    }
    if (this.#interrupted.has(id)) {
      this.#interrupted.delete(id);
      this.send({
        _tag: "Exit",
        requestId: id,
        exit: { _tag: "Failure", cause: [{ _tag: "Interrupt", fiberId: 1 }] },
      });
      return;
    }
    this.#exit(id, response.exit ?? { kind: "value", value: undefined });
  }

  #waitForAck(id: string): Promise<void> {
    return new Promise((resolve) => {
      this.#ackWaiters.set(id, () => {
        this.#ackWaiters.delete(id);
        resolve();
      });
    });
  }

  #exit(id: string, response: Exclude<FakeRpcResponse, { kind: "stream" | "hang" }>): void {
    if (this.#interrupted.has(id)) {
      this.#interrupted.delete(id);
      return;
    }
    const exit =
      response.kind === "value"
        ? { _tag: "Success", value: response.value }
        : response.kind === "fail"
          ? { _tag: "Failure", cause: [{ _tag: "Fail", error: response.error }] }
          : { _tag: "Failure", cause: [{ _tag: "Die", defect: response.defect }] };
    this.send({ _tag: "Exit", requestId: id, exit });
  }
}
