// ---
// relationships:
//   implements: heddle
// ---

export type ReconciliationPass = () => Promise<void>;

export type ProductionSchedulerOptions = {
  cadenceMilliseconds: number;
  onError?: (error: unknown) => Promise<void> | void;
  pass: ReconciliationPass;
  stopTimeoutMilliseconds: number;
};

export class ProductionScheduler {
  #active?: Promise<void>;
  #pending = false;
  #running = false;
  #stopping = false;
  #timer?: ReturnType<typeof globalThis.setInterval>;

  public constructor(private readonly options: ProductionSchedulerOptions) {}

  async start(): Promise<void> {
    if (this.#running) return;
    if (this.#stopping) throw new Error("The scheduler is stopping");
    this.#running = true;
    this.#timer = globalThis.setInterval(() => {
      void this.trigger()
        .catch((error: unknown) => this.#reportError(error))
        .catch(() => undefined);
    }, this.options.cadenceMilliseconds);
    try {
      await this.trigger();
    } catch (error) {
      await this.#reportError(error).catch(() => undefined);
      throw error;
    }
  }

  trigger(): Promise<void> {
    if (!this.#running || this.#stopping) return Promise.resolve();
    this.#pending = true;
    if (this.#active !== undefined) return this.#active;
    const active = this.#drain().finally(() => {
      if (this.#active === active) this.#active = undefined;
    });
    this.#active = active;
    return active;
  }

  async stop(): Promise<void> {
    if (!this.#stopping) {
      this.#stopping = true;
      this.#running = false;
      this.#pending = false;
      if (this.#timer !== undefined) {
        globalThis.clearInterval(this.#timer);
        this.#timer = undefined;
      }
    }
    const active = this.#active;
    if (active === undefined) return;
    let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
    try {
      await Promise.race([
        active,
        new Promise<never>((_resolve, reject) => {
          timeout = globalThis.setTimeout(
            () =>
              reject(new Error("Timed out draining the reconciliation pass")),
            this.options.stopTimeoutMilliseconds,
          );
        }),
      ]);
    } finally {
      if (timeout !== undefined) globalThis.clearTimeout(timeout);
    }
  }

  async #drain(): Promise<void> {
    while (this.#pending && !this.#stopping) {
      this.#pending = false;
      await this.options.pass();
    }
  }

  async #reportError(error: unknown): Promise<void> {
    await this.options.onError?.(error);
  }
}
