// ---
// relationships:
//   implements: heddle
// ---

import {
  LifecycleEngine,
  type LifecycleEffect,
  type LifecycleSnapshot,
  type RebaseLifecycleInput,
  type ResumeLifecycleInput,
  type StartLifecycleInput,
} from "../engine/index.js";
import type { SqlitePersistence } from "../persistence/index.js";
import type { ProductConfiguration } from "./configuration.js";

export class ProductionLifecycleRouter {
  private readonly engines: ReadonlyMap<string, LifecycleEngine>;
  private readonly persistence: SqlitePersistence;

  constructor(options: {
    effects: Record<string, LifecycleEffect>;
    persistence: SqlitePersistence;
    products: ProductConfiguration[];
  }) {
    this.persistence = options.persistence;
    this.engines = new Map(
      options.products.flatMap((product) =>
        product.repos.map((repository) => [
          repository.name,
          new LifecycleEngine({
            effects: options.effects,
            persistence: options.persistence,
            repositoryRoot: repository.repositoryRoot,
          }),
        ]),
      ),
    );
  }

  start(
    input: StartLifecycleInput & { repositoryName: string },
  ): Promise<LifecycleSnapshot> {
    return this.engine(input.repositoryName).start(input);
  }

  resume(input: ResumeLifecycleInput): Promise<LifecycleSnapshot> {
    return this.engineForInstance(input.instanceId).resume(input);
  }

  rebase(input: RebaseLifecycleInput): Promise<LifecycleSnapshot> {
    return this.engineForInstance(input.instanceId).rebase(input);
  }

  private engineForInstance(instanceId: string): LifecycleEngine {
    const runtimes = this.persistence
      .listReconcilerRuntime()
      .filter((runtime) => runtime.instanceId === instanceId);
    if (
      runtimes.length !== 1 ||
      runtimes[0]!.lifecycleRepositoryName === undefined
    ) {
      throw new Error(
        `Instance '${instanceId}' has no canonical lifecycle repository`,
      );
    }
    return this.engine(runtimes[0]!.lifecycleRepositoryName);
  }

  private engine(repositoryName: string): LifecycleEngine {
    const engine = this.engines.get(repositoryName);
    if (engine === undefined) {
      throw new Error(`Repository '${repositoryName}' has no lifecycle engine`);
    }
    return engine;
  }
}
