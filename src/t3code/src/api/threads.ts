import { T3PreconditionError, T3RpcError } from "../errors.js";
import type { RpcClient } from "../rpc/client.js";
import type { RpcMethods } from "../rpc/registry.js";
import type { ProjectId, ThreadId, TurnId } from "../schemas/common.js";
import type { ClientOrchestrationCommand } from "../schemas/orchestration/commands.js";
import type {
  ThreadCreateCommand,
  ThreadMetaUpdateCommand,
} from "../schemas/orchestration/commands/thread.js";
import type { ModelSelection } from "../schemas/orchestration/model.js";
import {
  OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadDetailWindow,
} from "../schemas/orchestration/read-model.js";
import type { OrchestrationThreadShell } from "../schemas/orchestration/shell.js";
import type { DispatchResult } from "../schemas/orchestration/stream.js";
import type { HttpTransport } from "../transport/http.js";
import { isMissingResourceError, type CommandDispatcher } from "./dispatch.js";
import { loadShellSnapshot } from "./shell.js";
import {
  ThreadCommands,
  type ApprovalResponseInput,
  type UserInputDismissInput,
  type UserInputResponseInput,
} from "./thread-commands.js";
import {
  pendingRequests,
  threadPhase,
  type PendingRequest,
  type ThreadPhase,
} from "./thread-projection.js";
import { watchThread, type ThreadWatchItem, type ThreadWatchOptions } from "./thread-watch.js";
import { createTurnHandle, type StartTurnInput, type TurnHandle } from "./turns.js";

export interface ThreadCreateInput {
  readonly threadId?: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly modelSelection: ModelSelection;
  /** Defaults to "full-access", the server's default. */
  readonly runtimeMode?: ThreadCreateCommand["runtimeMode"];
  readonly interactionMode?: ThreadCreateCommand["interactionMode"];
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
}

export type ThreadMetaUpdate = Omit<ThreadMetaUpdateCommand, "type" | "commandId" | "threadId">;

export interface ThreadListOptions {
  readonly projectId?: ProjectId;
  readonly includeArchived?: boolean;
}

export type WatchOptions = Omit<ThreadWatchOptions, "snapshotLoader">;

export class ThreadsApi {
  readonly #commands: ThreadCommands;

  constructor(
    readonly http: HttpTransport,
    readonly rpc: RpcClient<RpcMethods>,
    readonly dispatcher: CommandDispatcher,
  ) {
    this.#commands = new ThreadCommands(dispatcher);
  }

  async list(
    options: ThreadListOptions = {},
    signal?: AbortSignal,
  ): Promise<OrchestrationThreadShell[]> {
    const shell = await loadShellSnapshot(this.http, signal);
    const threads = [...shell.threads];
    if (options.includeArchived) {
      const archived = await this.rpc.call("orchestration.getArchivedShellSnapshot", {}, signal);
      const known = new Set(threads.map((thread) => thread.id));
      for (const thread of archived.threads) if (!known.has(thread.id)) threads.push(thread);
    }
    return options.projectId === undefined
      ? threads
      : threads.filter((thread) => thread.projectId === options.projectId);
  }

  async get(
    threadId: ThreadId,
    signal?: AbortSignal,
  ): Promise<OrchestrationThreadShell | undefined> {
    const active = (await this.list({}, signal)).find((thread) => thread.id === threadId);
    if (active) return active;
    const archived = await this.rpc.call("orchestration.getArchivedShellSnapshot", {}, signal);
    return archived.threads.find((thread) => thread.id === threadId);
  }

  detail(
    threadId: ThreadId,
    window: OrchestrationThreadDetailWindow = {},
    signal?: AbortSignal,
  ): Promise<OrchestrationThreadDetailSnapshot> {
    return this.http.request({
      method: "GET",
      path: `/api/orchestration/threads/${encodeURIComponent(threadId)}`,
      query: { turnLimit: window.turnLimit, beforeCursor: window.beforeCursor },
      auth: "required",
      decode: OrchestrationThreadDetailSnapshot,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async create(input: ThreadCreateInput, signal?: AbortSignal): Promise<OrchestrationThreadShell> {
    const threadId = input.threadId ?? this.dispatcher.newThreadId();
    await this.dispatch(
      {
        type: "thread.create",
        commandId: this.dispatcher.newCommandId(),
        threadId,
        projectId: input.projectId,
        title: input.title,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode ?? "full-access",
        interactionMode: input.interactionMode ?? "default",
        branch: input.branch ?? null,
        worktreePath: input.worktreePath ?? null,
        createdAt: this.dispatcher.now(),
      },
      signal,
    );
    const created = await this.get(threadId, signal);
    if (!created) {
      throw new T3PreconditionError(`Thread ${threadId} was created but is not in the shell.`);
    }
    return created;
  }

  async ensure(
    input: ThreadCreateInput & { readonly threadId: ThreadId },
    signal?: AbortSignal,
  ): Promise<OrchestrationThreadShell> {
    return (await this.get(input.threadId, signal)) ?? this.create(input, signal);
  }

  async update(threadId: ThreadId, patch: ThreadMetaUpdate, signal?: AbortSignal): Promise<void> {
    await this.dispatch(
      { ...patch, type: "thread.meta.update", commandId: this.dispatcher.newCommandId(), threadId },
      signal,
    );
  }

  async archive(threadId: ThreadId, signal?: AbortSignal): Promise<void> {
    await this.#tolerant(
      this.#commands.simple("thread.archive", threadId),
      signal,
      /\bdoes not exist\b|\bis already archived\b/,
    );
  }

  async unarchive(threadId: ThreadId, signal?: AbortSignal): Promise<void> {
    await this.dispatch(this.#commands.simple("thread.unarchive", threadId), signal);
  }

  async settle(threadId: ThreadId, signal?: AbortSignal): Promise<void> {
    await this.dispatch(this.#commands.simple("thread.settle", threadId), signal);
  }

  async delete(threadId: ThreadId, signal?: AbortSignal): Promise<void> {
    await this.#tolerant(this.#commands.simple("thread.delete", threadId), signal);
  }

  async setRuntimeMode(
    threadId: ThreadId,
    runtimeMode: ThreadCreateCommand["runtimeMode"],
    signal?: AbortSignal,
  ): Promise<void> {
    await this.dispatch(this.#commands.setRuntimeMode(threadId, runtimeMode), signal);
  }

  async setInteractionMode(
    threadId: ThreadId,
    interactionMode: ThreadCreateCommand["interactionMode"],
    signal?: AbortSignal,
  ): Promise<void> {
    await this.dispatch(this.#commands.setInteractionMode(threadId, interactionMode), signal);
  }

  async startTurn(input: StartTurnInput): Promise<TurnHandle> {
    const { signal } = input;
    let runtimeMode = input.runtimeMode;
    let interactionMode = input.interactionMode;
    if (runtimeMode === undefined || interactionMode === undefined) {
      const thread = await this.get(input.threadId, signal);
      if (!thread) throw new T3PreconditionError(`Thread ${input.threadId} does not exist.`);
      runtimeMode ??= asRuntimeMode(thread.runtimeMode);
      interactionMode ??= thread.interactionMode === "plan" ? "plan" : "default";
    }
    const commandId = this.dispatcher.newCommandId();
    const messageId = this.dispatcher.newMessageId();
    const createdAt = this.dispatcher.now();
    const receipt = await this.dispatch(
      {
        type: "thread.turn.start",
        commandId,
        threadId: input.threadId,
        message: {
          messageId,
          role: "user",
          text: input.text,
          attachments: input.attachments ?? [],
          ...(input.context === undefined ? {} : { context: input.context }),
        },
        ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
        ...(input.titleSeed === undefined ? {} : { titleSeed: input.titleSeed }),
        runtimeMode,
        interactionMode,
        ...(input.bootstrap === undefined ? {} : { bootstrap: input.bootstrap }),
        createdAt,
      },
      signal,
    );
    return createTurnHandle(
      {
        dispatch: (command, s) => this.dispatch(command, s),
        watch: (threadId, options) => this.watch(threadId, options),
        newCommandId: () => this.dispatcher.newCommandId(),
        now: () => this.dispatcher.now(),
      },
      {
        threadId: input.threadId,
        messageId,
        commandId,
        createdAt,
        sequence: receipt.sequence,
        ...(signal === undefined ? {} : { signal }),
      },
    );
  }

  async interrupt(threadId: ThreadId, turnId?: TurnId, signal?: AbortSignal): Promise<void> {
    await this.dispatch(this.#commands.interrupt(threadId, turnId), signal);
  }

  async stopSession(threadId: ThreadId, signal?: AbortSignal): Promise<void> {
    await this.dispatch(this.#commands.stopSession(threadId), signal);
  }

  async respondToApproval(input: ApprovalResponseInput, signal?: AbortSignal): Promise<void> {
    await this.dispatch(this.#commands.respondToApproval(input), signal);
  }

  async respondToUserInput(input: UserInputResponseInput, signal?: AbortSignal): Promise<void> {
    await this.dispatch(this.#commands.respondToUserInput(input), signal);
  }

  async dismissUserInput(input: UserInputDismissInput, signal?: AbortSignal): Promise<void> {
    await this.dispatch(this.#commands.dismissUserInput(input), signal);
  }

  async pendingRequests(threadId: ThreadId, signal?: AbortSignal): Promise<PendingRequest[]> {
    return pendingRequests((await this.detail(threadId, {}, signal)).thread);
  }

  watch(threadId: ThreadId, options: WatchOptions = {}): AsyncIterable<ThreadWatchItem> {
    return watchThread(this.rpc, threadId, {
      ...options,
      snapshotLoader: (signal) => this.detail(threadId, {}, signal),
    });
  }

  phase(thread: OrchestrationThreadShell): ThreadPhase {
    return threadPhase(thread);
  }

  dispatch(command: ClientOrchestrationCommand, signal?: AbortSignal): Promise<DispatchResult> {
    return this.dispatcher.dispatch(command, signal);
  }

  async #tolerant(
    command: ClientOrchestrationCommand,
    signal: AbortSignal | undefined,
    pattern?: RegExp,
  ): Promise<void> {
    try {
      await this.dispatch(command, signal);
    } catch (error) {
      const tolerated =
        pattern === undefined
          ? isMissingResourceError(error)
          : error instanceof T3RpcError &&
            error.tag === "OrchestrationDispatchCommandError" &&
            pattern.test(error.message);
      if (!tolerated) throw error;
    }
  }
}

const runtimeModes = ["approval-required", "auto-accept-edits", "auto", "full-access"] as const;

function asRuntimeMode(mode: string): ThreadCreateCommand["runtimeMode"] {
  const known = runtimeModes.find((candidate) => candidate === mode);
  return known ?? "full-access";
}
