// ---
// relationships:
//   implements: node-types
// ---
import {
  HookSessions,
  GeneratedToolService,
  type SessionBinding,
} from "../agent-tools/index.js";
import { threadId, type ThreadWatchItem } from "../t3code/index.js";
import { toolState } from "../agent-tools/state.js";
import { recordFailure } from "../engine/boundary.js";
import type { EngineNode, Run, WorkflowEngine } from "../engine/index.js";
import { preparePass, projectTitle, record } from "./prepare.js";
import { PassWatchState } from "./watch-state.js";
import { PassStore } from "./store.js";
import { observePass, seedPass } from "./observe.js";
import {
  dispatchPass,
  registerPass,
  retirePass,
  stopPriorSession,
} from "./lifecycle.js";
import type { PassInvocation, PassOptions, PassReadModel } from "./types.js";

export class PassService {
  readonly sessions: HookSessions;
  readonly tools: GeneratedToolService;
  private readonly store: PassStore;
  private readonly watches = new Map<string, PassWatchState>();
  private readonly registered = new Set<string>();
  private readonly stopRequests = new Set<string>();
  private readonly working = new Map<string, Promise<void>>();
  private readonly projects = new Map<string, Promise<unknown>>();
  private closed = false;
  constructor(
    private readonly engine: WorkflowEngine,
    private readonly options: PassOptions,
  ) {
    this.store = new PassStore(engine.store);
    this.sessions = new HookSessions(engine.store);
    this.tools = new GeneratedToolService(engine);
    // The listener is started only after recover() confirms authoritative identities.
    engine.store.db.exec("UPDATE hook_sessions SET session_id=NULL");
  }
  readonly node: EngineNode = async (context) => {
    let item = this.store.get(context.effectKey);
    if (!item) {
      item = await preparePass(context, this.options);
      this.store.save(item);
    }
    const current = item;
    let project = this.projects.get(item.worktree);
    if (!project) {
      project = this.options.client.projects.ensure({
        workspaceRoot: item.worktree,
        title: projectTitle(item.worktree),
      });
      this.projects.set(item.worktree, project);
      void project
        .finally(() => this.projects.delete(current.worktree))
        .catch(() => {
          /* The awaiting node reports the rejection. */
        });
    }
    await project;
    if (item.reused) {
      if (!(await this.options.client.threads.get(threadId(item.threadId))))
        throw new Error("Pass resumeThread does not exist in T3 Code");
    } else {
      const owner = await this.options.client.projects.findByWorkspaceRoot(
        item.worktree,
      );
      if (!owner) throw new Error("Pass project is missing after ensure");
      await this.options.client.threads.ensure({
        threadId: threadId(item.threadId),
        projectId: owner.id,
        title: context.nodeId,
        modelSelection: item.model,
        runtimeMode: item.runtimeMode,
        worktreePath: item.worktree,
      });
    }
    const stages = record(context.context["stages"]);
    stages[item.nodeId] = {
      visits: item.visit,
      threadId: item.threadId,
      handoff: null,
    };
    context.context["stages"] = stages;
    item.phase = "waiting";
    this.store.save(item);
    await context.await(item.details);
    return null;
  };
  /** Engine callback: durable awaiting/claim transitions precede external effects. */
  readonly synchronize = async (run: Run): Promise<void> => {
    for (const item of this.store.all(run.id)) {
      if (!this.store.awaiting(item)) {
        this.watches.get(item.key)?.controller.abort();
        this.watches.delete(item.key);
        this.registered.delete(item.key);
        if (item.phase !== "retired" || item.registrationNames.length) {
          item.binding = null;
          item.phase = "retired";
          this.store.save(item);
          this.sessions.reconcile();
          await this.working.get(item.key);
          await retirePass(item, this.options, this.store, this.sessions);
        }
      } else if (!this.closed && !this.watches.has(item.key)) this.watch(item);
      else {
        const active = this.watches.get(item.key);
        if (active?.synchronized) await this.advance(active.item);
      }
    }
    this.tools.recover();
  };
  async recover(): Promise<void> {
    this.sessions.reconcile();
    for (const run of this.engine.store.list()) await this.synchronize(run);
    await Promise.all([...this.watches.values()].map((watch) => watch.ready));
  }
  read(
    runId: string,
    nodeId: string,
    visit?: number,
  ): PassReadModel | undefined {
    const item = this.store
      .all(runId)
      .filter(
        (item) =>
          item.nodeId === nodeId &&
          (visit === undefined || item.visit === visit),
      )
      .at(-1);
    if (!item) return undefined;
    const awaiting = this.store.awaiting(item),
      state = awaiting ? toolState(awaiting) : undefined;
    return structuredClone({
      ...item.view,
      turnEndPolicy: state?.policy ?? item.view.turnEndPolicy,
    });
  }
  close(): void {
    this.closed = true;
    for (const watch of this.watches.values()) watch.controller.abort();
    this.watches.clear();
  }
  private watch(item: PassInvocation): void {
    const watching = new PassWatchState(item);
    const { controller } = watching;
    this.watches.set(item.key, watching);
    void this.consume(watching)
      .catch(async (error: unknown) => {
        watching.reject(error);
        if (controller.signal.aborted) return;
        recordFailure(this.engine.store, item.runId, error);
        await this.synchronize(this.engine.store.get(item.runId));
      })
      .catch((error: unknown) => {
        this.engine.store.event(item.runId, "attention", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }
  private async consume(watching: PassWatchState): Promise<void> {
    const { item, controller } = watching;
    for await (const update of this.options.client.threads.watch(
      threadId(item.threadId),
      {
        signal: controller.signal,
        ...(item.sequence === null ? {} : { afterSequence: item.sequence }),
      },
    )) {
      if (controller.signal.aborted || !this.store.awaiting(item)) return;
      if (update.kind === "decode-error") throw update.error;
      if (update.kind === "reconnected") {
        watching.synchronized = false;
        this.map(item, true);
      }
      if (update.kind === "snapshot" && !item.projection) {
        item.projection = update.snapshot.thread;
        item.sequence = update.snapshot.snapshotSequence;
        seedPass(item);
        this.store.save(item);
      }
      if (update.kind === "event" && observePass(item, update.event)) {
        this.engine.store.transaction(() => {
          this.store.save(item);
          if (item.view.lastActivity !== null)
            this.engine.wakeups.activity(
              item.runId,
              item.nodeId,
              item.view.lastActivity,
              false,
            );
        });
      }
      if (update.kind === "synchronized") watching.synchronized = true;
      if (!watching.synchronized) continue;
      await this.advance(item);
      if (item.phase === "active") this.map(item);
      watching.resolve();
      await this.settled(item, update);
    }
    if (!controller.signal.aborted && this.store.awaiting(item))
      throw new Error("Pass thread subscription ended");
  }
  private map(item: PassInvocation, clear = false): void {
    if (!item.binding) return;
    const binding: SessionBinding = {
      ...item.binding,
      runId: item.runId,
      nodeId: item.nodeId,
      visit: item.visit,
      threadId: item.threadId,
    };
    this.sessions.observe(
      binding,
      clear ? null : (item.projection?.session?.providerThreadId ?? null),
    );
  }
  private async advance(item: PassInvocation): Promise<void> {
    const busy = this.working.get(item.key);
    if (busy) return busy;
    const work = this.activate(item).finally(() =>
      this.working.delete(item.key),
    );
    this.working.set(item.key, work);
    await work;
  }
  private async activate(item: PassInvocation): Promise<void> {
    const awaiting = this.store.awaiting(item),
      run = this.engine.store.get(item.runId);
    if (!awaiting || run.paused || run.status !== "awaiting") return;
    if (item.phase === "active") {
      if (!this.registered.has(item.key)) {
        await registerPass(
          item,
          awaiting,
          this.options,
          this.store,
          this.sessions,
        );
        this.registered.add(item.key);
      }
      await dispatchPass(item, this.options, this.store);
      return;
    }
    const session = item.projection?.session;
    if (
      item.projection?.latestTurn?.state === "running" ||
      session?.activeTurnId
    )
      return;
    for (const old of this.store
      .all()
      .filter(
        (old) => old.threadId === item.threadId && old.key !== item.key,
      )) {
      if (this.store.awaiting(old))
        throw new Error("T3 thread already belongs to an active pass");
      if (old.registrationNames.length)
        await retirePass(old, this.options, this.store, this.sessions);
    }
    if (item.reused && session && session.status !== "stopped") {
      if (!this.stopRequests.has(item.key)) {
        await stopPriorSession(item, this.options, this.store);
        this.stopRequests.add(item.key);
      }
      return;
    }
    await registerPass(item, awaiting, this.options, this.store, this.sessions);
    this.registered.add(item.key);
    await dispatchPass(item, this.options, this.store);
  }
  private async settled(
    item: PassInvocation,
    update: ThreadWatchItem,
  ): Promise<void> {
    if (item.phase !== "active" || update.kind !== "turn-settled") return;
    const turn = update.outcome.turnId;
    if (turn !== null && !item.view.turns[turn]) return;
    if (this.store.awaiting(item))
      await this.tools.observeTurnEnd(item.binding?.path ?? "", {
        turnId: turn,
        state: update.outcome.state,
      });
  }
}
