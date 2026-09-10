// ---
// relationships:
//   implements: heddle
// ---

import { createHash } from "node:crypto";
import type { EscalationCoordinator } from "../mcp-server/index.js";
import { renderQuestionSet } from "../mcp-server/escalation-contract.js";
import { readLifecycleContext } from "../engine/lifecycle-state.js";
import { isTodoState } from "../todo/index.js";
import { isStageSessionTerminal } from "../control-plane/session-observation-liveness.js";
import { hasQueuedTurn } from "../control-plane/session-terminal-visibility.js";
import {
  requestIdsFor,
  userInputQuestionsFor,
} from "../control-plane/session-observation-attention.js";
import {
  resolveT3AwarenessPhase,
  steerStageSession,
  type SessionObservationTarget,
  type T3ShellThread,
} from "../control-plane/index.js";
import type { SqlitePersistence } from "../persistence/index.js";
import type { ProductionT3Client } from "./composition.js";
import { productionSessionBindingFor } from "./subagent-composition.js";
import { providerContextFromBinding } from "./session-binding.js";
import type { DurableAttentionQueue } from "./durable-adapters.js";
import { stableUuid } from "./stable-uuid.js";
import { isStoredAdjudicationHandoff } from "../mcp-server/session-binding.js";

const identity = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Owns harness requests before the observer can project operator attention. */
export class ProductionQuestionRouting {
  constructor(
    private readonly persistence: SqlitePersistence,
    private readonly escalation: EscalationCoordinator,
    private readonly t3: ProductionT3Client,
    private readonly attention: DurableAttentionQueue,
  ) {}

  async observe(
    target: SessionObservationTarget,
    thread: T3ShellThread | undefined,
  ): Promise<void> {
    const record = this.persistence.getInstance(target.instanceId)!;
    const pending = this.escalation
      .pendingEscalations(target.instanceId)
      .filter((question) => question.ownerSessionKey === target.sessionKey);
    if (thread === undefined) {
      for (const opened of pending) {
        this.escalation.withdraw(opened);
        this.attention.resolve(opened.attentionId);
      }
      return;
    }
    if (!thread.hasPendingUserInput && pending.length === 0) return;
    const snapshot = await this.t3.getThread(target.threadId);
    const requests = requestIdsFor(snapshot, "user-input.requested");
    for (const opened of pending) {
      if (
        !requests.includes(opened.requestId) &&
        snapshot.thread.activities?.some(
          (activity) => activity.payload?.requestId === opened.requestId,
        )
      ) {
        this.escalation.withdraw(opened);
        this.attention.resolve(opened.attentionId);
      }
    }
    const assignment = isTodoState(record.state.todoState)
      ? record.state.todoState.lists
          .flatMap((list) => list.assignments ?? [])
          .find((candidate) => candidate.sessionKey === target.sessionKey)
      : undefined;
    const runtime = this.persistence
      .listSessionRuntime()
      .find((candidate) => candidate.sessionKey === target.sessionKey);
    for (const requestId of requests) {
      await this.escalation.escalate(
        {
          instance: record,
          sessionKey: target.sessionKey,
          ...(assignment === undefined
            ? {}
            : { parentSessionKey: assignment.parentSessionKey }),
          stage: {
            id:
              runtime?.stageId ??
              readLifecycleContext(record).awaitingNodeIds[0]!,
            skills: [],
            tools: [],
          },
        },
        {
          escalationId: identity([target.threadId, requestId]),
          requestId,
          threadId: target.threadId,
          questions: userInputQuestionsFor(snapshot, requestId),
        },
      );
    }
  }

  async poke(
    target: SessionObservationTarget,
    thread: T3ShellThread | undefined,
  ): Promise<void> {
    if (
      thread === undefined ||
      thread.backgroundLiveness != null ||
      hasQueuedTurn(thread)
    )
      return;
    const phase = resolveT3AwarenessPhase(thread);
    if (
      [
        "running",
        "starting",
        "failed",
        "waiting_for_approval",
        "waiting_for_input",
      ].includes(phase)
    )
      return;
    const record = this.persistence.getInstance(target.instanceId)!;
    const pending = this.escalation.pendingEscalations(target.instanceId);
    if (
      pending.some((question) => question.ownerSessionKey === target.sessionKey)
    )
      return;
    const owed = pending.filter(
      ({ answeringAuthority }) =>
        answeringAuthority.kind !== "operator" &&
        answeringAuthority.sessionKey === target.sessionKey,
    );
    const runtime = this.persistence
      .listSessionRuntime()
      .find((candidate) => candidate.sessionKey === target.sessionKey);
    const isAdjudication = record.state.handoffs
      .filter(isStoredAdjudicationHandoff)
      .some((handoff) => handoff.sessionKey === target.sessionKey);
    if (
      owed.length === 0 &&
      (runtime === undefined ||
        isAdjudication ||
        isStageSessionTerminal(record, target.sessionKey))
    )
      return;
    const stableId = identity([
      target,
      thread.latestTurn ?? null,
      thread.latestUserMessageAt ?? null,
      owed.map((question) => question.attentionId),
    ]);
    const message =
      owed.length === 0
        ? "Keep working. Finish the work or use advance to disposition the stage. Do not stop before the stage advances."
        : owed.map(renderQuestionSet).join("\n\n");
    const intent = { ...target, message };
    this.persistence.recordEffectIntent(
      "session-continuation",
      stableId,
      intent,
    );
    if (this.persistence.effectCompleted("session-continuation", stableId))
      return;
    const binding = productionSessionBindingFor(
      this.persistence,
      target.sessionKey,
      target.threadId,
    );
    await steerStageSession(
      {
        commandId: stableUuid(`${stableId}:poke`),
        messageId: stableUuid(`${stableId}:message`),
        threadId: target.threadId,
        message,
        interactionMode: binding.interactionMode,
        runtimeMode: binding.runtimeMode,
        providerContext: providerContextFromBinding(binding),
      },
      { t3: this.t3 },
    );
    this.persistence.recordEffectCompleted("session-continuation", stableId);
  }
}
