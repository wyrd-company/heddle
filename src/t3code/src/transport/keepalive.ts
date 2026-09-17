/**
 * Ping/Pong liveness for one open socket: sends a Ping on an interval and
 * reports when the peer has missed too many Pongs. The owner decides what to
 * do about it (drop and reconnect). No T3 knowledge beyond the envelope.
 */
export interface KeepaliveOptions {
  readonly intervalMs: number;
  readonly missedPongLimit: number;
  /** Sends one Ping; may throw when the socket is closing, which is ignored. */
  readonly ping: () => void;
  readonly onTimeout: (missedPongs: number) => void;
}

export class Keepalive {
  readonly #options: KeepaliveOptions;
  #timer: ReturnType<typeof setInterval> | undefined;
  #missedPongs = 0;

  constructor(options: KeepaliveOptions) {
    this.#options = options;
  }

  start(): void {
    this.stop();
    this.#timer = setInterval(() => this.#tick(), this.#options.intervalMs);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#missedPongs = 0;
  }

  /** The peer answered; the missed count starts over. */
  pong(): void {
    this.#missedPongs = 0;
  }

  #tick(): void {
    if (this.#missedPongs >= this.#options.missedPongLimit) {
      const missed = this.#missedPongs;
      this.stop();
      this.#options.onTimeout(missed);
      return;
    }
    this.#missedPongs += 1;
    try {
      this.#options.ping();
    } catch {
      // The socket is closing; its close event handles it.
    }
  }
}
