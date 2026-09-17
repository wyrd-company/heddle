// ---
// relationships:
//   implements: github-binding-and-intake
// ---
import type { WorkflowEngine } from "../engine/engine.js";
import type { RunStore } from "../engine/store.js";
import type { Data, Run } from "../engine/types.js";
import { setCard } from "./effects.js";
import type { EventBoundProject } from "./event-service.js";
import type {
  Instance,
  InstanceStore,
  ProjectChoiceQuestion,
} from "./store.js";

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

  recoverAttachments(): void {
    for (const instance of this.instances.list()) {
      if (instance.runId || this.instances.ambiguous(instance.id)) continue;
      const lifecycle = this.lifecycleFor(instance);
      if (lifecycle) this.instances.attach(instance.id, lifecycle.id);
    }
  }

  async start(
    id: string,
    blueprintId: string,
    commit: string,
  ): Promise<IntakeResult> {
    await this.reconcileProjects();
    this.recoverAttachments();
    const instance = this.instances.get(id);
    if (instance.runId) return this.store.get(instance.runId);
    const question = this.instances.projectChoice(id);
    if (question?.answer === null) return question;
    const intake = await this.engine.start({
      id: `intake:${id}`,
      blueprintId,
      commit,
      context: { issue: structuredClone(this.instances.get(id).issue) },
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
