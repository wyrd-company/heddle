/**
 * RpcConnection: request/response correlation over a SocketTransport. One
 * `Request` per call; `Chunk`s feed an async iterable that acknowledges each
 * chunk once the consumer has drained it (backpressure); `Exit` settles the
 * request; `Interrupt` is sent when the consumer stops early or aborts. A
 * socket drop or `Defect` fails everything in flight.
 */
import {
  T3ConnectionError,
  T3InterruptedError,
  T3RpcDefectError,
  type T3Error,
} from "../errors.js";
import { createChannel, raceAbort, type Channel } from "../internal/async-iterable.js";
import { newId } from "../internal/ids.js";
import { noopLogger, type Logger } from "../internal/logger.js";
import { requestEnvelope, type ServerEnvelope } from "../wire/envelope.js";
import { exitToError, normalizeExit } from "../wire/exit.js";
import type { SocketTransport } from "./socket.js";

export interface RpcStreamOptions {
  readonly signal?: AbortSignal;
  /** Acknowledge a chunk once at most this many of its values are still buffered. Default 0. */
  readonly highWaterMark?: number;
}

export interface RpcConnectionOptions {
  readonly idGenerator?: () => string;
  readonly logger?: Logger;
}

interface CallEntry {
  readonly kind: "call";
  readonly tag: string;
  resolve(value: unknown): void;
  reject(error: T3Error): void;
}

interface StreamEntry {
  readonly kind: "stream";
  readonly tag: string;
  readonly channel: Channel<unknown>;
  readonly highWaterMark: number;
  /** Detaches the abort listener; idempotent. Called whenever the stream stops being in flight. */
  readonly release: () => void;
  ackPending: boolean;
}

type Entry = CallEntry | StreamEntry;

export class RpcConnection {
  readonly #socket: SocketTransport;
  readonly #nextId: () => string;
  readonly #logger: Logger;
  readonly #entries = new Map<string, Entry>();
  readonly #unsubscribe: (() => void)[];

  constructor(socket: SocketTransport, options: RpcConnectionOptions = {}) {
    this.#socket = socket;
    this.#nextId = options.idGenerator ?? newId;
    this.#logger = options.logger ?? noopLogger;
    this.#unsubscribe = [
      socket.onMessage((envelopes) => this.#onEnvelopes(envelopes)),
      socket.onStateChange((state, error) => {
        if (state === "open") return;
        this.#failAll(error ?? new T3ConnectionError("closed", "The socket closed."));
      }),
    ];
  }

  get inFlight(): number {
    return this.#entries.size;
  }

  /** Sends one request and resolves with the `Exit` success value. */
  async call(tag: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new T3InterruptedError(`${tag} was aborted before it was sent.`);
    await this.#socket.connect(signal);
    const id = this.#nextId();
    const settled = new Promise<unknown>((resolve, reject) => {
      this.#entries.set(id, { kind: "call", tag, resolve, reject });
    });
    this.#send(id, tag, payload);
    return raceAbort(settled, signal, () => {
      this.#interrupt(id);
      return new T3InterruptedError(`${tag} was aborted.`);
    });
  }

  /**
   * Sends one request and yields every value of every `Chunk` until the
   * `Exit`. The request is sent when iteration starts.
   */
  stream(tag: string, payload: unknown, options: RpcStreamOptions = {}): AsyncIterable<unknown> {
    return { [Symbol.asyncIterator]: () => this.#startStream(tag, payload, options) };
  }

  /** Closes the socket; everything in flight fails with `T3ConnectionError("closed")`. */
  async close(): Promise<void> {
    for (const off of this.#unsubscribe) off();
    this.#failAll(new T3ConnectionError("closed", "The connection was closed."));
    await this.#socket.close();
  }

  #startStream(tag: string, payload: unknown, options: RpcStreamOptions): AsyncIterator<unknown> {
    const id = this.#nextId();
    const highWaterMark = Math.max(0, options.highWaterMark ?? 0);
    const channel = createChannel<unknown>({
      onPull: (remaining) => this.#maybeAck(id, remaining),
      onReturn: () => this.#interrupt(id),
    });
    const { signal } = options;
    const onAbort = () => {
      this.#interrupt(id);
      channel.fail(new T3InterruptedError(`${tag} was aborted.`));
    };
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      signal?.removeEventListener("abort", onAbort);
    };
    const entry: StreamEntry = {
      kind: "stream",
      tag,
      channel,
      highWaterMark,
      release,
      ackPending: false,
    };

    const iterator = channel[Symbol.asyncIterator]();
    let started = false;
    const start = async (): Promise<void> => {
      if (signal?.aborted) {
        channel.fail(new T3InterruptedError(`${tag} was aborted before it was sent.`));
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        await this.#socket.connect(signal);
        if (channel.closed) return;
        this.#entries.set(id, entry);
        this.#send(id, tag, payload);
      } catch (error) {
        channel.fail(error);
      }
    };
    return {
      next: async () => {
        if (!started) {
          started = true;
          await start();
        }
        try {
          const result = await iterator.next();
          if (result.done) release();
          return result;
        } catch (error) {
          release();
          throw error;
        }
      },
      return: async () => {
        release();
        started = true;
        return iterator.return?.() ?? { done: true, value: undefined };
      },
    };
  }

  #send(id: string, tag: string, payload: unknown): void {
    try {
      this.#socket.sendEnvelope(requestEnvelope(id, tag, payload));
    } catch (error) {
      const entry = this.#entries.get(id);
      this.#entries.delete(id);
      const failure =
        error instanceof T3ConnectionError
          ? error
          : new T3ConnectionError("closed", "Sending the request failed.", { cause: error });
      if (entry) this.#settleWithError(entry, failure);
    }
  }

  #interrupt(id: string): void {
    const entry = this.#entries.get(id);
    if (!entry) return;
    this.#entries.delete(id);
    if (entry.kind === "stream") entry.release();
    try {
      this.#socket.sendEnvelope({ _tag: "Interrupt", requestId: id });
    } catch {
      // Not open: nothing to interrupt on the server side.
    }
  }

  #maybeAck(id: string, remaining: number): void {
    const entry = this.#entries.get(id);
    if (!entry || entry.kind !== "stream" || !entry.ackPending) return;
    if (remaining > entry.highWaterMark) return;
    entry.ackPending = false;
    try {
      this.#socket.sendEnvelope({ _tag: "Ack", requestId: id });
    } catch {
      // The socket dropped; the state change fails the stream.
    }
  }

  #onEnvelopes(envelopes: readonly ServerEnvelope[]): void {
    for (const envelope of envelopes) {
      switch (envelope._tag) {
        case "Chunk":
          this.#onChunk(envelope.requestId, envelope.values);
          break;
        case "Exit":
          this.#onExit(envelope.requestId, envelope.exit);
          break;
        case "Defect":
          this.#logger.error("The server reported a connection defect.", {
            defect: envelope.defect,
          });
          this.#failAll((tag) => new T3RpcDefectError(tag, envelope.defect));
          break;
        case "Pong":
          break;
      }
    }
  }

  #onChunk(id: string, values: readonly unknown[]): void {
    const entry = this.#entries.get(id);
    if (!entry) {
      this.#logger.debug("Chunk for an unknown request.", { requestId: id });
      return;
    }
    if (entry.kind === "call") {
      // A unary call is settled by its Exit; keep the server flowing.
      this.#socket.sendEnvelope({ _tag: "Ack", requestId: id });
      return;
    }
    for (const value of values) entry.channel.push(value);
    entry.ackPending = true;
    this.#maybeAck(id, entry.channel.size);
  }

  #onExit(id: string, exit: Parameters<typeof normalizeExit>[0]): void {
    const entry = this.#entries.get(id);
    if (!entry) return;
    this.#entries.delete(id);
    const outcome = normalizeExit(exit);
    if (entry.kind === "call") {
      if (outcome.kind === "success") entry.resolve(outcome.value);
      else entry.reject(exitToError(outcome, entry.tag));
      return;
    }
    entry.release();
    if (outcome.kind === "success") entry.channel.end();
    else entry.channel.fail(exitToError(outcome, entry.tag));
  }

  #failAll(error: T3Error | ((tag: string) => T3Error)): void {
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    for (const entry of entries) {
      this.#settleWithError(entry, typeof error === "function" ? error(entry.tag) : error);
    }
  }

  #settleWithError(entry: Entry, error: T3Error): void {
    if (entry.kind === "call") {
      entry.reject(error);
      return;
    }
    entry.release();
    entry.channel.fail(error);
  }
}
