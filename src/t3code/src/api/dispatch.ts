/**
 * CommandDispatcher: the one path every facade uses to send an orchestration
 * command. It validates the command, prefers the socket (typed
 * `OrchestrationDispatchCommandError`), and falls back to
 * `POST /api/orchestration/dispatch` only when the socket is fatally
 * unavailable. It also mints the bookkeeping ids and timestamps commands need.
 */
import { T3ConnectionError, T3PreconditionError, T3RpcError } from "../errors.js";
import { nowIso, systemClock, type Clock } from "../internal/clock.js";
import { newId } from "../internal/ids.js";
import type { RpcClient } from "../rpc/client.js";
import type { RpcMethods } from "../rpc/registry.js";
import {
  commandId,
  messageId,
  projectId,
  threadId,
  type CommandId,
  type MessageId,
  type ProjectId,
  type ThreadId,
} from "../schemas/common.js";
import { ClientOrchestrationCommand } from "../schemas/orchestration/commands.js";
import { DispatchResult } from "../schemas/orchestration/stream.js";
import type { HttpTransport } from "../transport/http.js";

export interface CommandDispatcherOptions {
  readonly clock?: Clock;
  readonly ids?: () => string;
}

export class CommandDispatcher {
  readonly #rpc: RpcClient<RpcMethods>;
  readonly #http: HttpTransport;
  readonly #clock: Clock;
  readonly #ids: () => string;

  constructor(
    rpc: RpcClient<RpcMethods>,
    http: HttpTransport,
    options: CommandDispatcherOptions = {},
  ) {
    this.#rpc = rpc;
    this.#http = http;
    this.#clock = options.clock ?? systemClock;
    this.#ids = options.ids ?? newId;
  }

  /** Command ids are attempt ids on the server, never idempotency keys: one per dispatch. */
  newCommandId(): CommandId {
    return commandId(this.#ids());
  }

  newMessageId(): MessageId {
    return messageId(this.#ids());
  }

  newThreadId(): ThreadId {
    return threadId(this.#ids());
  }

  newProjectId(): ProjectId {
    return projectId(this.#ids());
  }

  now(): string {
    return nowIso(this.#clock);
  }

  async dispatch(
    command: ClientOrchestrationCommand,
    signal?: AbortSignal,
  ): Promise<DispatchResult> {
    const parsed = ClientOrchestrationCommand.safeParse(command);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.path.map(String).join(".") || "command";
      throw new T3PreconditionError(
        `${command.type} is invalid: ${field}: ${issue?.message ?? "invalid value"}`,
        { cause: parsed.error },
      );
    }
    try {
      return await this.#rpc.call("orchestration.dispatchCommand", parsed.data, signal);
    } catch (error) {
      if (!(error instanceof T3ConnectionError) || error.reason !== "open_failed") throw error;
    }
    return this.#http.request({
      method: "POST",
      path: "/api/orchestration/dispatch",
      auth: "required",
      body: parsed.data,
      decode: DispatchResult,
      ...(signal === undefined ? {} : { signal }),
    });
  }
}

/** `true` when the server rejected the command because its thread or project does not exist. */
export function isMissingResourceError(error: unknown): boolean {
  return (
    error instanceof T3RpcError &&
    error.tag === "OrchestrationDispatchCommandError" &&
    /\bdoes not exist\b/.test(error.message)
  );
}
