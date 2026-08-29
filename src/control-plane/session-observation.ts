// ---
// relationships:
//   implements: heddle
//   references:
//     - t3-headless
//     - t3-session-visibility
// ---

import type { InstanceRecord } from "../persistence/index.js";
import { resolveT3AwarenessPhase } from "./t3-agent-awareness.js";
import {
  requestAttention,
  type RequestAttentionKind,
} from "./session-observation-attention.js";
import {
  interruptSession,
  stopSession,
} from "./session-observation-effects.js";
import {
  eventsForSession,
  sessionObservationEventTypes,
} from "./session-observation-events.js";
import { observeSessionLiveness } from "./session-observation-liveness.js";
import { archiveTerminalSession } from "./session-terminal-visibility.js";
import type {
  SessionObservationAttention,
  SessionObservationOptions,
  SessionObservationResult,
  SessionObservationTarget,
  StopSessionInput,
} from "./session-observation-types.js";
import type { T3ShellThread } from "./t3-control-plane-client.js";

const phaseFor = (
  thread: T3ShellThread | undefined,
): SessionObservationResult["phase"] =>
  thread === undefined ? "absent" : resolveT3AwarenessPhase(thread);

export class SessionObserver {
  readonly #nextId: () => string;
  readonly #now: () => number;

  constructor(private readonly options: SessionObservationOptions) {
    this.#nextId = options.nextId ?? (() => globalThis.crypto.randomUUID());
    this.#now = options.now ?? Date.now;
    for (const [name, value] of Object.entries(options.thresholds)) {
      if (!Number.isFinite(value) || value < 0) {
        throw new TypeError(`${name} must be a non-negative finite number`);
      }
    }
  }

  async observe(
    target: SessionObservationTarget,
  ): Promise<SessionObservationResult> {
    const record = this.#record(target.instanceId);
    this.#recordThread(target);
    const shell = await this.options.t3.getShell();
    const thread = shell.threads.find(({ id }) => id === target.threadId);
    const phase = phaseFor(thread);
    const attentions = await this.#requestAttentions(target, thread);
    const liveness = await observeSessionLiveness(
      this.options,
      target,
      phase,
      record,
      this.#now,
    );
    if (liveness !== undefined) attentions.push(liveness);
    const archiveDispatched = await archiveTerminalSession(
      this.options,
      target,
      thread,
      this.#nextId,
    );
    const result = { archiveDispatched, attentions, phase };
    await this.options.childStops?.onObserved(target, result);
    return result;
  }

  async answerApproval(
    target: SessionObservationTarget,
    requestId: string,
    decision: "accept" | "reject",
  ): Promise<void> {
    await this.options.t3.respondToApproval(
      target.threadId,
      requestId,
      decision,
    );
  }

  async answerUserInput(
    target: SessionObservationTarget,
    requestId: string,
    answers: Record<string, string | string[]>,
  ): Promise<void> {
    if (Object.keys(answers).length === 0) {
      throw new TypeError("User-input answers must not be empty");
    }
    await this.options.t3.respondToUserInput(
      target.threadId,
      requestId,
      answers,
    );
  }

  async interrupt(
    target: SessionObservationTarget,
    operationId: string,
  ): Promise<void> {
    await interruptSession(this.options, target, operationId, this.#nextId);
  }

  async stop(input: StopSessionInput): Promise<void> {
    await stopSession(this.options, input, this.#nextId);
  }

  #record(instanceId: string): InstanceRecord {
    const record = this.options.persistence.getInstance(instanceId);
    if (record === undefined) {
      throw new Error(`Instance does not exist: ${instanceId}`);
    }
    return record;
  }

  #recordThread(target: SessionObservationTarget): void {
    const events = eventsForSession(
      this.options.persistence.replayEvents(target.instanceId),
      target.sessionKey,
      target.threadId,
    );
    if (
      events.some(
        ({ type }) => type === sessionObservationEventTypes.threadRecorded,
      )
    ) {
      return;
    }
    this.options.persistence.appendEvent(
      target.instanceId,
      sessionObservationEventTypes.threadRecorded,
      target,
    );
  }

  async #requestAttentions(
    target: SessionObservationTarget,
    thread: T3ShellThread | undefined,
  ): Promise<SessionObservationAttention[]> {
    const kinds: RequestAttentionKind[] = [];
    if (thread?.hasPendingApprovals) kinds.push("approval");
    if (thread?.hasPendingUserInput) kinds.push("user-input");
    if (kinds.length === 0) return [];
    const snapshot = await this.options.t3.getThread(target.threadId);
    return Promise.all(
      kinds.map((kind) =>
        requestAttention(this.options, target, snapshot, kind),
      ),
    );
  }
}

export type {
  SessionObservationAttention,
  SessionObservationAttentionQueue,
  SessionObservationEscalations,
  SessionObservationOptions,
  SessionObservationPersistence,
  SessionObservationResult,
  SessionObservationT3Client,
  SessionObservationTarget,
  SessionObservationThresholds,
  StopSessionInput,
} from "./session-observation-types.js";
