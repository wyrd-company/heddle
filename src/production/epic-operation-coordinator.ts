// ---
// relationships:
//   implements: heddle
// ---

export interface EpicOperationBoundary {
  run<T>(epicId: number, operation: () => Promise<T>): Promise<T>;
}

export class EpicOperationCoordinator implements EpicOperationBoundary {
  readonly #tails = new Map<number, Promise<void>>();

  public async run<T>(epicId: number, operation: () => Promise<T>): Promise<T> {
    if (!Number.isSafeInteger(epicId) || epicId <= 0) {
      throw new Error("epic id must be a positive safe integer");
    }

    const previous = this.#tails.get(epicId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = previous.catch(() => undefined).then(() => gate);
    this.#tails.set(epicId, current);

    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.#tails.get(epicId) === current) this.#tails.delete(epicId);
    }
  }
}
