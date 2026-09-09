// ---
// relationships:
//   implements: heddle
// ---

import {
  LifecycleEngine,
  type LifecycleEffect,
  type LifecycleSnapshot,
  type MechanicalNodeUse,
  type RebaseLifecycleInput,
  type ResumeLifecycleInput,
  type StartLifecycleInput,
} from "../engine/index.js";
import type { SqlitePersistence } from "../persistence/index.js";
import type { TaskProviderAliasMap } from "../provider-alias.js";

export class ProductionLifecycleRouter {
  private readonly activeTransitions = new Map<string, number>();
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
    return this.#track(input.instanceId, () => this.engine.start(input));
  }

  plannedStartStage(input: StartLifecycleInput): Promise<string | undefined> {
    return this.engine.plannedStartStage(input);
  }

  validateTaskProviderAliases(
    instanceId: string,
    taskId: number,
    aliases: TaskProviderAliasMap | undefined,
  ): Promise<void> {
    return this.engine.validateTaskProviderAliases(instanceId, taskId, aliases);
  }

  resume(input: ResumeLifecycleInput): Promise<LifecycleSnapshot> {
    return this.#track(input.instanceId, () => this.engine.resume(input));
  }

  rebase(input: RebaseLifecycleInput): Promise<LifecycleSnapshot> {
    return this.engine.rebase(input);
  }

  boardStatusFor(
    instanceId: string,
    uses: MechanicalNodeUse,
  ): Promise<string | undefined> {
    return this.engine.boardStatusFor(instanceId, uses);
  }

  isTransitionActive(instanceId: string): boolean {
    return (this.activeTransitions.get(instanceId) ?? 0) > 0;
  }

  async #track(
    instanceId: string,
    operation: () => Promise<LifecycleSnapshot>,
  ): Promise<LifecycleSnapshot> {
    this.activeTransitions.set(
      instanceId,
      (this.activeTransitions.get(instanceId) ?? 0) + 1,
    );
    try {
      return await operation();
    } finally {
      const remaining = (this.activeTransitions.get(instanceId) ?? 1) - 1;
      if (remaining === 0) this.activeTransitions.delete(instanceId);
      else this.activeTransitions.set(instanceId, remaining);
    }
  }
}
