// ---
// relationships:
//   implements: github-binding-and-intake
// ---
import jsonata from "jsonata";
import type { WorkflowEngine } from "../engine/engine.js";
import type { RunStore } from "../engine/store.js";
import type { GitHub } from "../github/src/github.js";
import { parseIssueRef } from "../github/src/refs.js";
import type { IssueFieldSchema } from "../github/src/schema/types.js";
import {
  GitHubEventHandler,
  type GitHubEvent,
  type IssueDelivery,
} from "./delivery.js";
import { setCard } from "./effects.js";
import type { BoundProject } from "./reconcile.js";
import { snapshot, type IssueSnapshot } from "./snapshot.js";
import type { Instance, InstanceStore } from "./store.js";

export interface EventBoundProject {
  project: BoundProject;
  client: GitHub;
}

export class BindingEventService {
  readonly handler = new GitHubEventHandler((delivery) => this.apply(delivery));

  constructor(
    private readonly store: RunStore,
    private readonly instances: InstanceStore,
    private readonly engine: WorkflowEngine,
    private readonly project: (id: string) => EventBoundProject | undefined,
    private readonly discover: () => Promise<void>,
  ) {}

  private async refresh(issue: IssueSnapshot): Promise<IssueSnapshot> {
    const bound = this.project(issue.project.id);
    if (!bound) throw new Error("Issue is not in a reconciled project");
    const coords = parseIssueRef(issue.ref);
    const [loaded, card] = await Promise.all([
      bound.client
        .owner<IssueFieldSchema>(coords.owner)
        .repo(coords.repo)
        .issue(coords.number)
        .load(),
      bound.project
        .item(issue.project.itemId as Parameters<BoundProject["item"]>[0])
        .load(),
    ]);
    return snapshot(loaded, { ...issue.project, fields: card.values });
  }

  private async apply(delivery: IssueDelivery): Promise<boolean> {
    if (!this.instances.find(delivery.issueId)) {
      await this.discover();
      if (!this.instances.find(delivery.issueId)) return false;
    }
    const before = this.instances.get(delivery.issueId);
    const changed = await this.refresh(before.issue);
    if (!this.instances.applyDelivery(changed, delivery.updatedAt))
      return false;
    await this.applyBoardOperations(before, changed);
    await this.resumeIssueChange(changed);
    return true;
  }

  private async applyBoardOperations(
    instance: Instance,
    changed: IssueSnapshot,
  ): Promise<void> {
    if (!instance.runId) return;
    const run = this.store.get(instance.runId);
    const oldPaused = instance.issue.project.fields["Paused"];
    const newPaused = changed.project.fields["Paused"];
    if (oldPaused !== newPaused) {
      if (newPaused === "Yes" && !run.paused)
        this.engine.pauseInstance(instance.runId);
      if (newPaused === "No" && run.paused)
        await this.engine.resumeInstance(instance.runId);
    }
    const oldStatus = instance.issue.project.fields["Status"];
    const newStatus = changed.project.fields["Status"];
    if (oldStatus === newStatus) return;
    const pass = this.store
      .awaiting()
      .find(
        (item) =>
          item.details.kind === "pass" &&
          this.store.get(item.runId).rootId === instance.runId,
      );
    if (pass)
      await this.engine.resume({
        runId: pass.runId,
        nodeId: pass.nodeId,
        visit: pass.visit,
        result: "overridden",
        payload: { status: newStatus, issue: changed },
      });
  }

  private async resumeIssueChange(issue: IssueSnapshot): Promise<void> {
    for (const awaiting of this.store.findAwaiting("issueId", issue.id)) {
      const condition = awaiting.details["condition"];
      const bindings = awaiting.details["bindings"] as
        Record<string, unknown> | undefined;
      const matches =
        typeof condition !== "string" ||
        Boolean(
          await (jsonata(condition).evaluate(
            issue,
            bindings ?? {},
          ) as Promise<unknown>),
        );
      if (!matches) continue;
      await this.engine.resume({
        runId: awaiting.runId,
        nodeId: awaiting.nodeId,
        visit: awaiting.visit,
        result: "changed",
        payload: issue,
      });
    }
  }

  async poll(): Promise<number> {
    let applied = 0;
    for (const instance of this.instances.list()) {
      const current = await this.refresh(instance.issue);
      if (JSON.stringify(current) === JSON.stringify(instance.issue)) continue;
      if (
        await this.handler.deliver("issues", {
          issue: { node_id: current.id, updated_at: current.updatedAt },
        })
      )
        applied++;
    }
    return applied;
  }

  deliver(event: GitHubEvent, payload: unknown): Promise<boolean> {
    return this.handler.deliver(event, payload);
  }

  async setPaused(id: string, paused: boolean): Promise<void> {
    const instance = this.instances.get(id);
    if (!instance.runId) throw new Error("Instance has no lifecycle run");
    if (paused) this.engine.pauseInstance(instance.runId);
    else await this.engine.resumeInstance(instance.runId);
    const bound = this.project(instance.issue.project.id);
    if (!bound) throw new Error("Issue is not in a reconciled project");
    await setCard(
      bound.project,
      instance.issue,
      "Paused",
      paused ? "Yes" : "No",
    );
    this.instances.update(instance.issue);
  }
}
