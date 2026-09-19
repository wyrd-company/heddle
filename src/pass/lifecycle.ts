// ---
// relationships:
//   implements: node-types
// ---
import { commandId, messageId, threadId } from "../t3code/index.js";
import type { HookSessions } from "../agent-tools/index.js";
import type { Awaiting } from "../engine/index.js";
import type { PassInvocation, PassOptions } from "./types.js";
import type { PassStore } from "./store.js";
import { record } from "./prepare.js";

export async function registerPass(
  item: PassInvocation,
  awaiting: Awaiting,
  options: PassOptions,
  store: PassStore,
  sessions: HookSessions,
): Promise<void> {
  if (!item.binding) throw new Error("Active pass credential is missing");
  const registrations = [
    {
      name: "heddle",
      threadId: threadId(item.threadId),
      endpoint: new URL(item.binding.path, options.toolOrigin).href,
      authorizationHeader: `Bearer ${item.binding.token}`,
    },
  ];
  for (const tool of item.tools) {
    const authorizationHeader = await options.extraToolAuthorization?.(tool);
    if (!authorizationHeader)
      throw new Error(
        `No service authorization configured for extra tool ${tool.name}`,
      );
    registrations.push({
      ...tool,
      threadId: threadId(item.threadId),
      authorizationHeader,
    });
  }
  for (const registration of registrations) {
    if (store.get(item.key)?.phase === "retired") return;
    // Persist intent before the remote PUT so crash recovery can clear it.
    if (!item.registrationNames.includes(registration.name))
      item.registrationNames.push(registration.name);
    store.save(item);
    await options.client.mcp.ensureRegistration(registration);
  }
  if (store.get(item.key)?.phase === "retired") return;
  sessions.register(awaiting, item.binding);
  item.phase = "active";
  store.save(item);
}
export async function dispatchPass(
  item: PassInvocation,
  options: PassOptions,
  store: PassStore,
): Promise<void> {
  if (
    item.dispatched ||
    store.get(item.key)?.phase === "retired" ||
    store.runs.get(item.runId).paused
  )
    return;
  await options.client.threads.dispatch({
    type: "thread.turn.start",
    threadId: threadId(item.threadId),
    commandId: commandId(item.commandId),
    message: {
      messageId: messageId(item.messageId),
      role: "user",
      text: item.prompt,
      attachments: [],
    },
    modelSelection: item.model,
    runtimeMode: item.runtimeMode,
    interactionMode: "default",
    createdAt: item.createdAt,
  });
  item.dispatched = true;
  store.save(item);
}
export async function stopPriorSession(
  item: PassInvocation,
  options: PassOptions,
  store: PassStore,
): Promise<void> {
  item.phase = "stopping";
  store.save(item);
  await options.client.threads.dispatch({
    type: "thread.session.stop",
    commandId: commandId(`${item.commandId}-stop`),
    threadId: threadId(item.threadId),
    createdAt: item.createdAt,
  });
}
export async function retirePass(
  item: PassInvocation,
  options: PassOptions,
  store: PassStore,
  sessions: HookSessions,
): Promise<void> {
  store.runs.transaction(() => {
    item.binding = null;
    item.phase = "retired";
    store.save(item);
    sessions.reconcile();
    const resume = store.runs
      .events(item.runId)
      .findLast(
        (event) =>
          event.type === "resume" &&
          record(event.payload)["nodeId"] === item.nodeId &&
          record(event.payload)["visit"] === item.visit,
      );
    const payload = record(resume?.payload);
    if (payload["result"] === "handoff") {
      const run = store.runs.get(item.runId);
      for (const context of [run.context, run.checkpoint.context]) {
        const stages = record(context["stages"]);
        stages[item.nodeId] = {
          ...record(stages[item.nodeId]),
          handoff: payload["payload"],
        };
        context["stages"] = stages;
      }
      store.runs.save(run.id, run.context, run.checkpoint);
    }
  });
  for (const name of [...item.registrationNames]) {
    await options.client.mcp.clear({ threadId: threadId(item.threadId), name });
    item.registrationNames = item.registrationNames.filter(
      (value) => value !== name,
    );
    store.save(item);
  }
}
