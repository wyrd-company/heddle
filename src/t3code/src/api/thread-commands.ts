/**
 * Builders for the thread commands ThreadsApi dispatches. Each fills the
 * server bookkeeping (`commandId`, `createdAt`) from the dispatcher so the
 * facade methods stay one line each.
 */
import type { ApprovalRequestId, CommandId, ThreadId, TurnId } from "../schemas/common.js";
import type { ClientOrchestrationCommand } from "../schemas/orchestration/commands.js";
import type { ThreadCreateCommand } from "../schemas/orchestration/commands/thread.js";
import type {
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
} from "../schemas/orchestration/commands/turn.js";
import type { CommandDispatcher } from "./dispatch.js";

export interface ApprovalResponseInput {
  readonly threadId: ThreadId;
  readonly requestId: ApprovalRequestId;
  readonly decision: ThreadApprovalRespondCommand["decision"];
}

export interface UserInputResponseInput {
  readonly threadId: ThreadId;
  readonly requestId: ApprovalRequestId;
  readonly answers: ThreadUserInputRespondCommand["answers"];
  readonly attachmentsByQuestionId?: ThreadUserInputRespondCommand["attachmentsByQuestionId"];
}

export interface UserInputDismissInput {
  readonly threadId: ThreadId;
  readonly requestId: ApprovalRequestId;
}

type Stamped = { readonly commandId: CommandId; readonly createdAt: string };

export class ThreadCommands {
  constructor(readonly dispatcher: CommandDispatcher) {}

  #stamp(): Stamped {
    return { commandId: this.dispatcher.newCommandId(), createdAt: this.dispatcher.now() };
  }

  simple(
    type: "thread.archive" | "thread.unarchive" | "thread.settle" | "thread.delete",
    threadId: ThreadId,
  ): ClientOrchestrationCommand {
    return { type, commandId: this.dispatcher.newCommandId(), threadId };
  }

  setRuntimeMode(
    threadId: ThreadId,
    runtimeMode: ThreadCreateCommand["runtimeMode"],
  ): ClientOrchestrationCommand {
    return { type: "thread.runtime-mode.set", threadId, runtimeMode, ...this.#stamp() };
  }

  setInteractionMode(
    threadId: ThreadId,
    interactionMode: ThreadCreateCommand["interactionMode"],
  ): ClientOrchestrationCommand {
    return { type: "thread.interaction-mode.set", threadId, interactionMode, ...this.#stamp() };
  }

  interrupt(threadId: ThreadId, turnId?: TurnId): ClientOrchestrationCommand {
    return {
      type: "thread.turn.interrupt",
      threadId,
      ...(turnId === undefined ? {} : { turnId }),
      ...this.#stamp(),
    };
  }

  stopSession(threadId: ThreadId): ClientOrchestrationCommand {
    return { type: "thread.session.stop", threadId, ...this.#stamp() };
  }

  respondToApproval(input: ApprovalResponseInput): ClientOrchestrationCommand {
    return {
      type: "thread.approval.respond",
      threadId: input.threadId,
      requestId: input.requestId,
      decision: input.decision,
      ...this.#stamp(),
    };
  }

  respondToUserInput(input: UserInputResponseInput): ClientOrchestrationCommand {
    return {
      type: "thread.user-input.respond",
      threadId: input.threadId,
      requestId: input.requestId,
      answers: input.answers,
      ...(input.attachmentsByQuestionId === undefined
        ? {}
        : { attachmentsByQuestionId: input.attachmentsByQuestionId }),
      ...this.#stamp(),
    };
  }

  dismissUserInput(input: UserInputDismissInput): ClientOrchestrationCommand {
    return {
      type: "thread.user-input.dismiss",
      threadId: input.threadId,
      requestId: input.requestId,
      ...this.#stamp(),
    };
  }
}
