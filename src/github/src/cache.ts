/**
 * Per-instance name -> value tables, grouped by scope. A scope is spelled by
 * `scopes` in refs.ts. Catalog writes invalidate their scope.
 */
export class NameCache {
  readonly #tables = new Map<string, Map<string, unknown>>();

  get<T>(scope: string, name: string): T | undefined {
    return this.#tables.get(scope)?.get(name) as T | undefined;
  }

  set<T>(scope: string, name: string, value: T): T {
    let table = this.#tables.get(scope);
    if (!table) {
      table = new Map();
      this.#tables.set(scope, table);
    }
    table.set(name, value);
    return value;
  }

  has(scope: string): boolean {
    return this.#tables.has(scope);
  }

  /** Returns the cached value or loads, stores and returns it. */
  async remember<T>(scope: string, name: string, load: () => Promise<T>): Promise<T> {
    const hit = this.get<T>(scope, name);
    if (hit !== undefined) return hit;
    return this.set(scope, name, await load());
  }

  /** Loads a whole scope once. Later reads hit the table until invalidated. */
  async table<T>(
    scope: string,
    load: () => Promise<Iterable<[string, T]>>,
  ): Promise<Map<string, T>> {
    const existing = this.#tables.get(scope);
    if (existing) return existing as Map<string, T>;
    const table = new Map<string, T>(await load());
    this.#tables.set(scope, table);
    return table;
  }

  /**
   * Runs a mutation that uses an id taken from `scope`. A NOT_FOUND failure
   * drops the table before rethrowing so the next call re-resolves.
   */
  async withIdsFrom<T>(scope: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if ((error as { code?: string }).code === "NOT_FOUND") this.invalidate(scope);
      throw error;
    }
  }

  invalidate(scope: string): void {
    this.#tables.delete(scope);
  }

  clear(): void {
    this.#tables.clear();
  }
}
