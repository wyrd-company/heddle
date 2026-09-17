/**
 * SocketTransport: one logical WebSocket connection to `/ws` that survives
 * drops. It opens lazily, keeps the link alive with Ping/Pong, reconnects with
 * backoff until `close()`, and hands decoded server envelopes to listeners.
 * `url()` and `headers()` run on every attempt, so a ticket URL is refreshed;
 * a `T3AuthError` from them, a 4xx upgrade, or close code 1008 is fatal.
 */
import { T3AuthError, T3ConnectionError, T3InterruptedError } from "../errors.js";
import { createBackoff, defaultBackoffPolicy, type BackoffPolicy } from "../internal/backoff.js";
import { noopLogger, type Logger } from "../internal/logger.js";
import {
  closeWebSocket,
  openWebSocket,
  terminateWebSocket,
  type WebSocketCloseInfo,
  type WebSocketConstructor,
  type WebSocketLike,
} from "../internal/websocket.js";
import {
  decodeServerFrame,
  encodeClientEnvelope,
  type ClientEnvelope,
  type ServerEnvelope,
} from "../wire/envelope.js";
import { Keepalive } from "./keepalive.js";
import { closeError } from "./socket-close.js";

export type SocketState = "idle" | "connecting" | "open" | "closed";

export interface SocketTransportOptions {
  /** Resolves the upgrade URL for each attempt (for example with a fresh ticket). */
  readonly url: () => Promise<URL>;
  /** Extra upgrade headers for each attempt (for example `authorization`). */
  readonly headers?: () => Promise<Record<string, string>>;
  /** Defaults to `globalThis.WebSocket`. */
  readonly webSocket?: WebSocketConstructor;
  readonly pingIntervalMs?: number;
  readonly missedPongLimit?: number;
  readonly backoff?: BackoffPolicy;
  readonly logger?: Logger;
}

export type MessageHandler = (envelopes: readonly ServerEnvelope[]) => void;
export type StateHandler = (state: SocketState, error?: T3ConnectionError) => void;

interface OpenWaiter {
  resolve(): void;
  reject(error: Error): void;
}

export class SocketTransport {
  readonly #options: SocketTransportOptions;
  readonly #logger: Logger;
  readonly #backoff;
  readonly #keepalive: Keepalive;
  readonly #messageHandlers = new Set<MessageHandler>();
  readonly #stateHandlers = new Set<StateHandler>();
  #state: SocketState = "idle";
  #socket: WebSocketLike | undefined;
  #generation = 0;
  #openWaiters: OpenWaiter[] = [];
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #closing = false;

  constructor(options: SocketTransportOptions) {
    this.#options = options;
    this.#logger = options.logger ?? noopLogger;
    this.#backoff = createBackoff(options.backoff ?? defaultBackoffPolicy);
    this.#keepalive = new Keepalive({
      intervalMs: options.pingIntervalMs ?? 5_000,
      missedPongLimit: options.missedPongLimit ?? 3,
      ping: () => this.sendEnvelope({ _tag: "Ping" }),
      onTimeout: (missedPongs) => {
        this.#logger.warn("Ping timeout.", { missedPongs });
        this.#dropSocket(
          new T3ConnectionError("ping_timeout", "The server stopped answering pings."),
        );
      },
    });
  }

  get state(): SocketState {
    return this.#state;
  }

  /** Resolves when the socket is open. Idempotent; concurrent callers share the attempt. */
  connect(signal?: AbortSignal): Promise<void> {
    if (this.#state === "open") return Promise.resolve();
    const aborted = () => new T3InterruptedError("Connecting was aborted.");
    if (this.#state === "closed") {
      return Promise.reject(new T3ConnectionError("closed", "The socket transport is closed."));
    }
    if (signal?.aborted) return Promise.reject(aborted());
    const wait = new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.#openWaiters = this.#openWaiters.filter((w) => w !== waiter);
        reject(aborted());
      };
      const detach = () => signal?.removeEventListener("abort", onAbort);
      const waiter: OpenWaiter = {
        resolve: () => {
          detach();
          resolve();
        },
        reject: (error) => {
          detach();
          reject(error);
        },
      };
      this.#openWaiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    if (this.#state === "idle") {
      this.#setState("connecting");
      void this.#attempt();
    }
    return wait;
  }

  /** Sends one text frame. Throws `T3ConnectionError("closed")` when the socket is not open. */
  send(text: string): void {
    if (this.#state !== "open" || !this.#socket) {
      throw new T3ConnectionError("closed", "The socket is not open.");
    }
    this.#socket.send(text);
  }

  sendEnvelope(envelope: ClientEnvelope): void {
    this.send(encodeClientEnvelope(envelope));
  }

  onMessage(handler: MessageHandler): () => void {
    this.#messageHandlers.add(handler);
    return () => this.#messageHandlers.delete(handler);
  }

  onStateChange(handler: StateHandler): () => void {
    this.#stateHandlers.add(handler);
    return () => this.#stateHandlers.delete(handler);
  }

  /**
   * Drops the socket and opens a new one right away, so the next upgrade
   * resolves `url()` and `headers()` again (for example after the credential
   * changed). In-flight work fails with `closed`. No-op when idle, closed, or
   * already waiting to reconnect.
   */
  reconnect(): void {
    if (this.#state === "idle" || this.#state === "closed" || this.#reconnectTimer) return;
    this.#keepalive.stop();
    const socket = this.#detachSocket();
    if (socket) terminateWebSocket(socket);
    this.#logger.info("Socket reconnecting on request.");
    this.#setState(
      "connecting",
      new T3ConnectionError("closed", "The socket was dropped to reconnect."),
    );
    void this.#attempt();
  }

  /** Stops reconnecting and closes the socket. Safe to call more than once. */
  async close(): Promise<void> {
    if (this.#state === "closed") return;
    this.#closing = true;
    this.#stopTimers();
    this.#rejectWaiters(new T3ConnectionError("closed", "The socket transport was closed."));
    const socket = this.#detachSocket();
    this.#setState("closed");
    if (socket) await closeWebSocket(socket, "client closed");
  }

  async #attempt(): Promise<void> {
    const generation = ++this.#generation;
    let url: URL;
    let headers: Record<string, string> | undefined;
    try {
      url = await this.#options.url();
      headers = await this.#options.headers?.();
    } catch (error) {
      if (generation !== this.#generation || this.#closing) return;
      if (error instanceof T3AuthError) {
        this.#fail(new T3ConnectionError("open_failed", error.message, { cause: error }));
        return;
      }
      this.#logger.warn("Resolving the socket URL failed; retrying.", { error: String(error) });
      this.#scheduleReconnect(
        new T3ConnectionError("open_failed", "Resolving the socket URL failed.", { cause: error }),
      );
      return;
    }
    if (generation !== this.#generation || this.#closing) return;
    const ctor =
      this.#options.webSocket ?? (globalThis.WebSocket as unknown as WebSocketConstructor);
    const isCurrent = () => generation === this.#generation;
    this.#socket = openWebSocket(ctor, url.toString(), headers, {
      onOpen: () => isCurrent() && this.#onOpen(),
      onMessage: (data) => isCurrent() && this.#onMessage(data),
      onError: (message) => isCurrent() && this.#logger.debug("Socket error.", { message }),
      onClose: (info) => isCurrent() && this.#onClose(info),
    });
  }

  #onOpen(): void {
    this.#backoff.reset();
    this.#setState("open");
    this.#keepalive.start();
    const waiters = this.#openWaiters;
    this.#openWaiters = [];
    for (const waiter of waiters) waiter.resolve();
  }

  #onMessage(data: unknown): void {
    if (typeof data !== "string") {
      this.#logger.warn("Ignoring a non-text socket frame.");
      return;
    }
    let envelopes: ServerEnvelope[];
    try {
      envelopes = decodeServerFrame(data, this.#logger);
    } catch (error) {
      this.#dropSocket(
        error instanceof T3ConnectionError
          ? error
          : new T3ConnectionError("protocol", "Decoding a frame failed.", { cause: error }),
      );
      return;
    }
    const forward = envelopes.filter((envelope) => {
      if (envelope._tag !== "Pong") return true;
      this.#keepalive.pong();
      return false;
    });
    if (forward.length === 0) return;
    for (const handler of this.#messageHandlers) handler(forward);
  }

  #onClose(info: WebSocketCloseInfo): void {
    this.#keepalive.stop();
    this.#socket = undefined;
    if (this.#closing) return;
    const { error, fatal } = closeError(info, this.#state === "open");
    if (fatal) this.#fail(error);
    else this.#scheduleReconnect(error);
  }

  /** Abandons the current socket (stale events are ignored) and reconnects. */
  #dropSocket(error: T3ConnectionError): void {
    this.#keepalive.stop();
    const socket = this.#detachSocket();
    if (socket) terminateWebSocket(socket);
    this.#scheduleReconnect(error);
  }

  #scheduleReconnect(error: T3ConnectionError): void {
    if (this.#closing) return;
    const delay = this.#backoff.next();
    this.#logger.info("Socket disconnected; reconnecting.", {
      reason: error.reason,
      delayMs: delay,
      attempt: this.#backoff.attempt,
    });
    this.#setState("connecting", error);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      void this.#attempt();
    }, delay);
  }

  #fail(error: T3ConnectionError): void {
    this.#logger.error("Socket failed permanently.", {
      reason: error.reason,
      message: error.message,
    });
    this.#closing = true;
    this.#stopTimers();
    const socket = this.#detachSocket();
    if (socket) terminateWebSocket(socket);
    this.#rejectWaiters(error);
    this.#setState("closed", error);
  }

  #stopTimers(): void {
    this.#keepalive.stop();
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
  }

  #detachSocket(): WebSocketLike | undefined {
    this.#generation += 1;
    const socket = this.#socket;
    this.#socket = undefined;
    return socket;
  }

  #rejectWaiters(error: T3ConnectionError): void {
    const waiters = this.#openWaiters;
    this.#openWaiters = [];
    for (const waiter of waiters) waiter.reject(error);
  }

  #setState(state: SocketState, error?: T3ConnectionError): void {
    this.#state = state;
    for (const handler of this.#stateHandlers) handler(state, error);
  }
}
