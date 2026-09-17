// ---
// relationships:
//   implements: github-binding-and-intake
// ---
import type { Blueprint } from "../blueprints/types.js";
import { WorkflowEngine } from "../engine/engine.js";
import type { RunStore } from "../engine/store.js";
import type { EngineOptions, EngineNodeContext } from "../engine/types.js";
import type { GitHub } from "../github/src/github.js";
import type { IssueFieldSchema } from "../github/src/schema/types.js";
import { parseIssueRef } from "../github/src/refs.js";
import { GitHubError } from "../github/src/transport/errors.js";
import type { ClientFactory, ProjectBinding } from "./config.js";
import { githubEffect, permissionAttention, setCard } from "./effects.js";
import { reconcileProject, type BoundProject } from "./reconcile.js";
import {
  snapshot,
  IssueFrontMatterError,
  type IssueSnapshot,
} from "./snapshot.js";
import { InstanceStore } from "./store.js";
import { GitHubEventHandler, type GitHubEvent } from "./delivery.js";
import { BindingEventService } from "./event-service.js";
import { onIssueChange } from "./issue-change.js";
import { BindingIntakeService, type IntakeResult } from "./intake-service.js";

export interface BindingServiceOptions {
  intake?: { blueprintId: string; commit: string };
}

export class GitHubBindingService {
  readonly instances: InstanceStore;
  readonly engine: WorkflowEngine;
  readonly events: GitHubEventHandler;
  private readonly eventService: BindingEventService;
  private readonly intakeService: BindingIntakeService;
  private projects = new Map<
    string,
    { project: BoundProject; client: GitHub; binding: ProjectBinding }
  >();
  constructor(
    readonly store: RunStore,
    private readonly bindings: readonly ProjectBinding[],
    private readonly clients: ClientFactory,
    private readonly blueprints: () => Promise<readonly Blueprint[]>,
    engineOptions: EngineOptions,
    private readonly options: BindingServiceOptions = {},
  ) {
    this.instances = new InstanceStore(store.db);
    this.engine = new WorkflowEngine(store, {
      ...engineOptions,
      nodes: {
        ...engineOptions.nodes,
        "on-issue-change": onIssueChange,
        github: async (context) => {
          try {
            const bound = this.bound(context);
            await githubEffect(
              context,
              bound.project,
              bound.client,
              this.instances,
            );
          } catch (error) {
            await permissionAttention(error, context, store);
          }
        },
      },
      beforeNode: async (context, definition) => {
        await engineOptions.beforeNode?.(context, definition);
        if ((definition as { stage?: boolean }).stage !== true) return;
        try {
          const { project } = this.bound(context);
          const issue = context.context["issue"] as IssueSnapshot;
          await setCard(project, issue, "Status", definition.id);
          this.instances.update(issue);
        } catch (error) {
          await permissionAttention(error, context, store);
        }
      },
    });
    this.eventService = new BindingEventService(
      store,
      this.instances,
      this.engine,
      (id) => this.projects.get(id),
      () => this.discover(),
    );
    this.events = this.eventService.handler;
    this.intakeService = new BindingIntakeService(
      store,
      this.instances,
      this.engine,
      () => this.reconcile(),
      (id) => this.projects.get(id),
    );
  }
  private bound(context: EngineNodeContext) {
    const issue = context.context["issue"] as IssueSnapshot | undefined;
    const bound = issue && this.projects.get(issue.project.id);
    if (!bound) throw new Error("Run issue is not in a bound project");
    return bound;
  }
  async reconcile(): Promise<void> {
    const blueprints = await this.blueprints();
    const projects: typeof this.projects = new Map();
    for (const binding of this.bindings) {
      const key = `${binding.owner}/${String(binding.number)}`;
      try {
        const client = this.clients(binding.owner);
        const project = await reconcileProject(
          client,
          binding,
          blueprints,
          (message) => {
            this.instances.attention(key, message);
          },
        );
        projects.set(project.id, { project, client, binding });
      } catch (error) {
        if (
          !(error instanceof GitHubError) ||
          !["FORBIDDEN", "SCHEMA_MISMATCH"].includes(error.code)
        )
          throw error;
        this.instances.attention(key, error.message);
      }
    }
    this.projects = projects;
  }
  async start(): Promise<void> {
    await this.reconcile();
    await this.discover();
    this.intakeService.recoverAttachments();
    if (this.options.intake)
      for (const instance of this.instances.list())
        if (!instance.runId)
          await this.intakeService.start(
            instance.id,
            this.options.intake.blueprintId,
            this.options.intake.commit,
          );
  }
  async discover(): Promise<void> {
    for (const binding of this.bindings) {
      const bound = [...this.projects.values()].find(
        (x) =>
          x.binding.number === binding.number &&
          x.binding.owner === binding.owner,
      );
      // Resolve by owner and number; project numbers are owner-local.
      if (!bound) continue;
      try {
        const project = await bound.client
          .owner<IssueFieldSchema>(binding.owner)
          .project(binding.number)
          .open();
        for await (const card of project.items({ archived: false })) {
          if (card.type !== "issue" || !card.contentRef) continue;
          const coords = parseIssueRef(card.contentRef);
          const existing = this.instances.find(card.contentId);
          if (existing) {
            this.instances.membership({
              ...existing.issue,
              project: {
                id: project.id,
                owner: binding.owner,
                number: binding.number,
                itemId: card.id,
                fields: card.values,
              },
            });
            if (existing.issue.project.id !== project.id)
              this.instances.projectChoice(existing.id);
            continue;
          }
          const issue = await bound.client
            .owner<IssueFieldSchema>(coords.owner)
            .repo(coords.repo)
            .issue(coords.number)
            .load();
          if (issue.state !== "open") continue;
          try {
            this.instances.discover(
              snapshot(issue, {
                id: project.id,
                owner: binding.owner,
                number: binding.number,
                itemId: card.id,
                fields: card.values,
              }),
            );
          } catch (error) {
            if (!(error instanceof IssueFrontMatterError)) throw error;
            this.instances.attention(project.id, error.message);
          }
        }
      } catch (error) {
        if (!(error instanceof GitHubError) || error.code !== "FORBIDDEN")
          throw error;
        this.instances.attention(
          `${binding.owner}/${String(binding.number)}`,
          error.message,
        );
      }
    }
  }
  async poll(): Promise<number> {
    return this.eventService.poll();
  }
  async deliver(event: GitHubEvent, payload: unknown): Promise<boolean> {
    return this.eventService.deliver(event, payload);
  }
  async pauseInstance(id: string): Promise<void> {
    await this.eventService.setPaused(id, true);
  }
  async resumeInstance(id: string): Promise<void> {
    await this.eventService.setPaused(id, false);
  }
  startIntake(
    id: string,
    blueprintId: string,
    commit: string,
  ): Promise<IntakeResult> {
    return this.intakeService.start(id, blueprintId, commit);
  }
  answerProjectChoice(
    id: string,
    occurrenceId: string,
    projectId: string,
  ): Promise<void> {
    return this.intakeService.answerProjectChoice(id, occurrenceId, projectId);
  }
  async resolvePermissionAttention(
    runId: string,
    nodeId: string,
    visit: number,
  ): Promise<"applied" | "late-wakeup" | "held"> {
    const active = this.store
      .awaiting(runId)
      .find(
        (item) =>
          item.nodeId === nodeId &&
          item.visit === visit &&
          item.details.kind === "github-attention",
      );
    if (!active)
      return this.engine.resume({
        runId,
        nodeId,
        visit,
        result: "resolved",
      });
    return this.engine.resume({
      runId,
      nodeId,
      visit,
      result: "resolved",
      payload: { occurrence: [runId, nodeId, visit] },
    });
  }
  async startInstance(id: string, blueprintId: string, commit: string) {
    await this.reconcile();
    const instance = this.instances.get(id);
    if (this.instances.ambiguous(id))
      throw new Error(
        "Issue belongs to multiple bound projects; select its project before starting",
      );
    if (
      instance.runId &&
      this.store.db.prepare("SELECT 1 FROM runs WHERE id=?").get(instance.runId)
    ) {
      const run = this.store.get(instance.runId);
      if (run.blueprintId !== blueprintId || run.commit !== commit)
        throw new Error(
          "Instance already has a different lifecycle invocation",
        );
      await this.engine.recover(run.rootId);
      return this.store.get(run.id);
    }
    if (!this.projects.has(instance.issue.project.id))
      throw new Error(
        "Project reconciliation requires attention before starting an instance",
      );
    const runId = instance.runId ?? `issue:${id}`;
    this.instances.attach(id, runId);
    return this.engine.start({
      id: runId,
      blueprintId,
      commit,
      context: { issue: structuredClone(instance.issue) },
    });
  }
}
