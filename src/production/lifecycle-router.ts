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

export class ProductionLifecycleRouter {
  private readonly engine: LifecycleEngine;

  constructor(options: {
    effects: Record<string, LifecycleEffect>;
    persistence: SqlitePersistence;
    repositoryRoot: string;
    sourceRef: string;
  }) {
    this.engine = new LifecycleEngine({
      effects: options.effects,
      persistence: options.persistence,
      repositoryRoot: options.repositoryRoot,
      sourceRef: options.sourceRef,
    });
  }

  start(input: StartLifecycleInput): Promise<LifecycleSnapshot> {
    return this.engine.start(input);
  }

  resume(input: ResumeLifecycleInput): Promise<LifecycleSnapshot> {
    return this.engine.resume(input);
  }

  rebase(input: RebaseLifecycleInput): Promise<LifecycleSnapshot> {
    return this.engine.rebase(input);
  }
}
