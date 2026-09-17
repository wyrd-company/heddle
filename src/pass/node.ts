// ---
// relationships:
//   implements: node-types
// ---
import { threadId } from "../t3code/index.js";
import type { EngineNodeContext } from "../engine/index.js";
import type { PassOptions } from "./types.js";
import type { PassStore } from "./store.js";
import { preparePass, projectTitle, record } from "./prepare.js";

export async function runPassNode(
  context: EngineNodeContext,
  options: PassOptions,
  store: PassStore,
  projects: Map<string, Promise<unknown>>,
): Promise<null> {
  let item = store.get(context.effectKey);
  if (!item) {
    item = await preparePass(context, options);
    store.save(item);
  }
  const current = item;
  let project = projects.get(item.worktree);
  if (!project) {
    project = options.client.projects.ensure({
      workspaceRoot: item.worktree,
      title: projectTitle(item.worktree),
    });
    projects.set(item.worktree, project);
    void project
      .finally(() => projects.delete(current.worktree))
      .catch(() => {
        /* The awaiting node reports the rejection. */
      });
  }
  await project;
  if (item.reused) {
    if (!(await options.client.threads.get(threadId(item.threadId))))
      throw new Error("Pass resumeThread does not exist in T3 Code");
  } else {
    const owner = await options.client.projects.findByWorkspaceRoot(
      item.worktree,
    );
    if (!owner) throw new Error("Pass project is missing after ensure");
    await options.client.threads.ensure({
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
  store.save(item);
  await context.await(item.details);
  return null;
}
