// ---
// relationships:
//   implements: engine-and-run-model
// ---
import { randomUUID } from "node:crypto";
import type { WorkflowBlueprint, WorkflowResult } from "flowcraft";
import jsonata from "jsonata";
import { claimResume, drainQueued } from "./claims.js";
import { bindNode } from "./nodes.js";
import { Attention, DurableRuntime, isDispatchHeld } from "./runtime.js";
import { RunStore } from "./store.js";
import type {
  Awaiting,
  Data,
  EngineOptions,
  ResumeInput,
  Run,
} from "./types.js";
import { Wakeups } from "./wakeups.js";
import { createRun } from "./create-run.js";
import { DurableTraversal } from "./traversal.js";

export class WorkflowEngine {
  readonly wakeups: Wakeups;
  private readonly clock: () => number;
  private readonly active: Map<string, Promise<Run>>;
  constructor(
    readonly store: RunStore,
    private readonly options: EngineOptions,
  ) {
    this.active = store.active;
    this.clock = options.clock ?? Date.now;
    this.wakeups = new Wakeups(store);
  }
  async start(input: {
    blueprintId: string;
    commit: string;
    context?: Data;
    id?: string;
  }): Promise<Run> {
    const id = input.id ?? randomUUID();
    const run = await createRun(this.store, this.options.resolveBlueprint, {
      ...input,
      id,
      rootId: id,
      parentId: null,
      parentNodeId: null,
    });
    return run.status === "awaiting" ? run : this.execute(run.id);
  }
  async resume(
    request: ResumeInput,
  ): Promise<"applied" | "late-wakeup" | "held"> {
    const outcome = claimResume(this.store, request);
    if (outcome === "applied") await this.execute(request.runId);
    return outcome;
  }
  private execute(runId: string): Promise<Run> {
    const current = this.active.get(runId);
    if (current) return current;
    const work = this.traverse(runId, () => {
      if (this.active.get(runId) === work) this.active.delete(runId);
    }).finally(() => {
      if (this.active.get(runId) === work) this.active.delete(runId);
    });
    this.active.set(runId, work);
    return work;
  }
  private async traverse(runId: string, release: () => void): Promise<Run> {
    const run = this.store.get(runId);
    if (run.paused || run.status === "completed" || run.status === "failed")
      return run;
    const runtime = new DurableRuntime();
    runtime.registry.clear();
    const blueprint = structuredClone(run.blueprint);
    for (const definition of blueprint.nodes) {
      const alias = `node:${definition.id}`;
      runtime.registry.set(
        alias,
        bindNode(
          this.store,
          runtime,
          run,
          { ...definition },
          this.options.nodes?.[definition.uses],
          this.clock,
          this.options.beforeNode,
        ),
      );
      definition.uses = alias;
    }
    // Bind closures before replacing names in the execution blueprint.
    const checkpoint = run.checkpoint;
    const details = checkpoint.context["_awaitingDetails"] as
      Record<string, Data> | undefined;
    if (
      checkpoint.nodeId &&
      details?.[checkpoint.nodeId]?.["kind"] !== "checkpoint"
    )
      runtime.resumedNodeId = checkpoint.nodeId;
    try {
      runtime.orchestrator = new DurableTraversal(
        this.store,
        runId,
        runtime,
        checkpoint,
      );
      const result = await runtime.run(
        blueprint,
        JSON.stringify(checkpoint.context),
        { concurrency: 1 },
      );
      this.settle(runId, result);
    } catch (error) {
      this.store.transaction(() => {
        this.store.status(runId, "failed");
        this.store.event(runId, "failure", {
          message: error instanceof Error ? error.message : String(error),
        });
        this.store.event(runId, "attention", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }
    // Release the traversal claim before child completion enters resume.
    release();
    await this.drainHeld(runId);
    await this.dispatchChildren(runId);
    await this.deliverCompletion(runId);
    return this.store.get(runId);
  }
  private settle(runId: string, result: WorkflowResult<Data>): void {
    if (
      this.store.get(runId).paused &&
      result.status === "failed" &&
      result.errors?.every((error) => isDispatchHeld(error.originalError))
    )
      return;
    if (
      (result.errors?.length ?? 0) > 0 ||
      (result.status !== "awaiting" && result.status !== "completed")
    )
      throw new Attention(
        `Run landed in ${result.status}: ${result.errors?.map((error) => error.message).join("; ") ?? ""}`,
      );
    this.store.transaction(() => {
      const status =
        this.store.awaiting(runId).length > 0 ? "awaiting" : result.status;
      this.store.save(
        runId,
        result.context,
        { context: result.context, frontier: [] },
        status === "awaiting" ? "awaiting" : "completed",
      );
      if (status === "completed") this.store.event(runId, "completed", {});
    });
  }
  private async dispatchChildren(runId: string): Promise<void> {
    const parent = this.store.get(runId);
    if (parent.paused || parent.status !== "awaiting") return;
    for (const item of this.store.awaiting(runId)) {
      if (item.details.kind !== "child-run" || !item.details.childRunId)
        continue;
      try {
        const child = await createRun(
          this.store,
          this.options.resolveBlueprint,
          {
            id: item.details.childRunId,
            blueprintId: String(item.details["blueprint"]),
            commit: parent.commit,
            context: item.details["inputs"] as Data,
            rootId: parent.rootId,
            parentId: runId,
            parentNodeId: item.nodeId,
          },
        );
        if (child.status === "running" || child.status === "resuming")
          await this.execute(child.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.store.event(runId, "attention", { nodeId: item.nodeId, message });
        await this.resume({
          runId,
          nodeId: item.nodeId,
          visit: item.visit,
          result: "failed",
          payload: { message },
        });
      }
    }
  }
  private async deliverCompletion(runId: string): Promise<void> {
    const child = this.store.get(runId);
    if (
      !child.parentId ||
      (child.status !== "completed" && child.status !== "failed")
    )
      return;
    const awaiting = this.store.findAwaiting("childRunId", child.id)[0];
    if (!awaiting) return;
    let result = child.status === "completed" ? "completed" : "failed";
    let payload: Data;
    try {
      payload =
        child.status === "failed"
          ? { runId: child.id, events: this.store.events(child.id) }
          : await this.childOutputs(child, awaiting);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.event(child.parentId, "attention", {
        nodeId: awaiting.nodeId,
        message,
      });
      result = "failed";
      payload = { runId: child.id, message };
    }
    await this.resume({
      runId: child.parentId,
      nodeId: awaiting.nodeId,
      visit: awaiting.visit,
      result,
      payload,
    });
  }
  private async childOutputs(child: Run, awaiting: Awaiting): Promise<Data> {
    const declared =
      (child.blueprint as WorkflowBlueprint & { outputs?: Data }).outputs ?? {};
    const mapping =
      (awaiting.details["outputs"] as Record<string, string> | undefined) ??
      Object.fromEntries(Object.keys(declared).map((key) => [key, key]));
    return Object.fromEntries(
      await Promise.all(
        Object.entries(mapping).map(
          async ([key, path]): Promise<[string, unknown]> => [
            key,
            (await jsonata(path).evaluate(child.context)) as unknown,
          ],
        ),
      ),
    );
  }
  async recover(rootId?: string): Promise<void> {
    for (const listed of this.store.list()) {
      const run = this.store.get(listed.id);
      if (rootId !== undefined && run.rootId !== rootId) continue;
      if (run.paused || this.active.has(run.id)) continue;
      try {
        if (run.status === "running" || run.status === "resuming")
          await this.execute(run.id);
        await this.drainHeld(run.id);
        await this.dispatchChildren(run.id);
        await this.deliverCompletion(run.id);
      } catch (error) {
        this.store.transaction(() => {
          this.store.status(run.id, "failed");
          const message =
            error instanceof Error ? error.message : String(error);
          this.store.event(run.id, "failure", { message });
          this.store.event(run.id, "attention", { message });
        });
      }
    }
  }
  private drainHeld(runId: string): Promise<void> {
    return drainQueued(this.store, runId, (id) => this.execute(id));
  }
  pauseInstance(runId: string): void {
    const root = this.store.get(runId).rootId;
    this.store.transaction(() => {
      this.store.db
        .prepare("UPDATE runs SET paused=1 WHERE root_id=?")
        .run(root);
      this.store.event(root, "instance-paused", {});
    });
  }
  async resumeInstance(runId: string): Promise<void> {
    const root = this.store.get(runId).rootId;
    this.store.transaction(() => {
      this.store.db
        .prepare("UPDATE runs SET paused=0 WHERE root_id=?")
        .run(root);
      this.store.event(root, "instance-resumed", {});
    });
    await this.recover(root);
    await this.tick();
  }
  async tick(): Promise<void> {
    await this.wakeups.tick(this.clock(), (request) => this.resume(request));
  }
}
