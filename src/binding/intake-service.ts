// ---
// relationships:
//   implements: github-binding-and-intake
// ---
import type { WorkflowEngine } from "../engine/engine.js";
import type { RunStore } from "../engine/store.js";
import type { Data, Run } from "../engine/types.js";
import { failureMessage } from "../engine/boundary.js";
import { setCard } from "./effects.js";
import { attemptDue, nextAttempt } from "./intake-attempts.js";
import type { EventBoundProject } from "./event-service.js";
import type {
  Instance,
  InstanceStore,
  IntakeAttempt,
  ProjectChoiceQuestion,
} from "./store.js";
import type { IssueSnapshot } from "./snapshot.js";

function issueId(context: Data): string | undefined {
  const issue = context["issue"];
  if (issue === null || typeof issue !== "object" || Array.isArray(issue))
    return undefined;
  const id = (issue as Data)["id"];
  return typeof id === "string" ? id : undefined;
}

export type IntakeResult = Run | ProjectChoiceQuestion;

export class BindingIntakeService {
  constructor(
    private readonly store: RunStore,
    private readonly instances: InstanceStore,
    private readonly engine: WorkflowEngine,
    private readonly reconcileProjects: () => Promise<void>,
    private readonly project: (id: string) => EventBoundProject | undefined,
  ) {}

  private lifecycleFor(instance: Instance): Run | undefined {
    const candidates = this.store.lifecycleStarts().flatMap((link) => {
      const source = this.store.get(link.runId);
      if (issueId(source.initialContext) !== instance.id) return [];
      const lifecycle = this.store.get(link.lifecycleRunId);
      if (issueId(lifecycle.initialContext) !== instance.id)
        throw new Error("Lifecycle attachment issue identity does not agree");
      return [lifecycle];
    });
    if (candidates.length > 1)
      throw new Error("Instance has multiple selected lifecycle runs");
    return candidates[0];
  }

  /** One instance's disagreement is its own; it never stops the others. */
  recoverAttachments(): void {
    for (const instance of this.instances.list()) {
      if (instance.runId || this.instances.ambiguous(instance.id)) continue;
      try {
        const lifecycle = this.lifecycleFor(instance);
        if (lifecycle) this.instances.attach(instance.id, lifecycle.id);
      } catch (error) {
        this.attention(instance.id, undefined, error);
      }
    }
  }

  /** A failure is recorded against the instance and its attempt run, not thrown. */
  attention(id: string, runId: string | undefined, error: unknown): void {
    const message = failureMessage(error);
    this.instances.attention(id, message);
    if (
      runId !== undefined &&
      this.store.db.prepare("SELECT 1 FROM runs WHERE id=?").get(runId)
    )
      this.store.event(runId, "attention", { message });
  }

  /** The attempt this issue is on, starting a new one when something changed. */
  private attempt(
    id: string,
    issue: IssueSnapshot,
    commit: string,
    restarted: boolean,
  ): IntakeAttempt {
    const recorded = this.instances.intakeAttempt(id);
    const inputs = { issue, commit, restarted };
    if (recorded !== undefined && !attemptDue(this.store, recorded, inputs))
      return recorded;
    const attempt = nextAttempt(id, recorded, inputs);
    this.instances.recordIntakeAttempt(attempt);
    return attempt;
  }

  /** Whether calling start would begin a new attempt rather than replay one. */
  due(id: string, commit: string, restarted: boolean): boolean {
    const instance = this.instances.get(id);
    return attemptDue(this.store, this.instances.intakeAttempt(id), {
      issue: instance.issue,
      commit,
      restarted,
    });
  }

  /**
   * The current attempt is replayed with the commit and issue snapshot it was
   * created with, so an identical re-invocation is idempotent however the
   * configured revision or the live issue has moved on since.
   */
  async start(
    id: string,
    blueprintId: string,
    commit: string,
    restarted = false,
  ): Promise<IntakeResult> {
    await this.reconcileProjects();
    this.recoverAttachments();
    const instance = this.instances.get(id);
    if (instance.runId) return this.store.get(instance.runId);
    const question = this.instances.projectChoice(id);
    if (question?.answer === null) return question;
    const attempt = this.attempt(id, instance.issue, commit, restarted);
    const intake = await this.engine.start({
      id: attempt.runId,
      blueprintId,
      commit: attempt.commit,
      context: { issue: JSON.parse(attempt.snapshot) as Data },
    });
    const lifecycle = this.lifecycleFor(this.instances.get(id));
    if (!lifecycle) return intake;
    this.instances.attach(id, lifecycle.id);
    return lifecycle;
  }

  async answerProjectChoice(
    id: string,
    occurrenceId: string,
    projectId: string,
  ): Promise<void> {
    const question = this.instances.projectChoice(id);
    if (question?.id !== occurrenceId)
      throw new Error("Project choice occurrence is not active");
    if (question.answer !== null) {
      if (question.answer !== projectId)
        throw new Error("Project choice is already answered");
      return;
    }
    const issue = this.instances.membershipFor(id, projectId);
    if (!issue) throw new Error("Issue is not in that bound project");
    const bound = this.project(projectId);
    if (!bound) throw new Error("Selected project is not reconciled");
    await setCard(
      bound.project,
      issue,
      "Heddle Project",
      `${issue.project.owner}/${String(issue.project.number)}`,
    );
    this.instances.chooseProject(id, projectId);
    this.instances.update(issue);
  }
}
