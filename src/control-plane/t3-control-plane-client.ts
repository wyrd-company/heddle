// ---
// relationships:
//   implements: heddle
//   references: t3-headless
// ---

import {
  resolveT3AwarenessPhase,
  type T3AwarenessPhase,
  type T3ShellThread,
} from "./t3-agent-awareness.js";
import {
  assertT3ProviderDispatchPreconditions,
  t3ProviderPreconditions,
  type T3ProviderDispatchContext,
  type T3ProviderPreconditionTable,
} from "./t3-provider-preconditions.js";

export {
  resolveT3AwarenessPhase,
  type T3AwarenessPhase,
  type T3ShellThread,
} from "./t3-agent-awareness.js";
export {
  t3ProviderPreconditions,
  T3ProviderPreconditionError,
  type T3ProviderDispatchContext,
  type T3ProviderPreconditionReason,
  type T3ProviderPreconditionTable,
  type T3ProviderVersionPreconditions,
  type T3SessionLifecycle,
} from "./t3-provider-preconditions.js";

export type T3ShellSnapshot = {
  threads: T3ShellThread[];
  [key: string]: unknown;
};

export type T3ThreadActivity = {
  kind: string;
  payload?: { requestId?: string; [key: string]: unknown };
  [key: string]: unknown;
};

export type T3UserInputQuestion = {
  header?: string;
  id: string;
  multiSelect: boolean;
  options: Array<{
    description?: string;
    label: string;
  }>;
  question: string;
};

export type T3ThreadSnapshot = {
  snapshotSequence?: number;
  thread: {
    activities?: T3ThreadActivity[];
    [key: string]: unknown;
  };
};

export type T3DispatchCommand = {
  type: string;
  commandId: string;
  threadId?: string;
  projectId?: string;
  requestId?: string;
  [key: string]: unknown;
};

export type T3TokenExchange = {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
};

export type T3WorkflowMcpProviderSession = {
  authorizationHeader: string;
  endpoint: string;
  threadId: string;
};

export type T3ThreadObservation = {
  phase: T3AwarenessPhase;
  thread: T3ShellThread;
};

export class T3PreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "T3PreconditionError";
  }
}

export class T3HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "T3HttpError";
  }
}

export type T3ControlPlaneClientOptions = {
  baseUrl: string;
  accessToken?: string;
  fetch?: typeof globalThis.fetch;
  providerPreconditions?: T3ProviderPreconditionTable;
};

type FetchRequestInit = NonNullable<Parameters<typeof globalThis.fetch>[1]>;
type FetchAbortSignal = NonNullable<FetchRequestInit["signal"]>;

export class T3ControlPlaneClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #providerPreconditions: T3ProviderPreconditionTable;
  #accessToken?: string;

  constructor(options: T3ControlPlaneClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#accessToken = options.accessToken;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#providerPreconditions =
      options.providerPreconditions ?? t3ProviderPreconditions;
  }

  async exchangePairingToken(
    pairingToken: string,
    clientLabel: string,
  ): Promise<T3TokenExchange> {
    if (pairingToken.length === 0)
      throw new T3PreconditionError("Pairing token must not be empty");
    if (clientLabel.length === 0)
      throw new T3PreconditionError("Client label must not be empty");

    const body = new globalThis.URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: pairingToken,
      subject_token_type:
        "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      client_label: clientLabel,
    });
    const token = await this.#request<T3TokenExchange>("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!token.access_token)
      throw new T3HttpError(
        "T3 token exchange returned no access token",
        200,
        token,
      );
    this.#accessToken = token.access_token;
    return token;
  }

  async getShell(): Promise<T3ShellSnapshot> {
    this.#requireAccessToken("read the orchestration shell");
    return this.#request<T3ShellSnapshot>("/api/orchestration/shell");
  }

  async getThread(threadId: string): Promise<T3ThreadSnapshot> {
    this.#requireAccessToken("read a thread snapshot");
    return this.#request<T3ThreadSnapshot>(
      `/api/orchestration/threads/${encodeURIComponent(threadId)}`,
    );
  }

  async observeThread(threadId: string): Promise<T3ThreadObservation> {
    const shell = await this.getShell();
    const thread = shell.threads.find(({ id }) => id === threadId);
    if (!thread)
      throw new T3PreconditionError(
        `Thread '${threadId}' is absent from the T3 shell snapshot`,
      );
    return { thread, phase: resolveT3AwarenessPhase(thread) };
  }

  async *pollThread(
    threadId: string,
    intervalMs = 3_000,
    signal?: FetchAbortSignal,
  ): AsyncGenerator<T3ThreadObservation> {
    if (intervalMs < 0)
      throw new T3PreconditionError("Polling interval must not be negative");
    while (!signal?.aborted) {
      yield await this.observeThread(threadId);
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          globalThis.clearTimeout(timer);
          reject(signal?.reason ?? new Error("Polling aborted"));
        };
        const timer = globalThis.setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, intervalMs);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }

  async dispatch<T extends { sequence: number } = { sequence: number }>(
    command: T3DispatchCommand,
    providerContext?: T3ProviderDispatchContext,
  ): Promise<T> {
    this.#requireAccessToken(`dispatch '${command.type}'`);
    if (command.type === "thread.turn.start") {
      if (!command.threadId)
        throw new T3PreconditionError(
          "Dispatch 'thread.turn.start' requires threadId",
        );
      assertT3ProviderDispatchPreconditions(
        this.#providerPreconditions,
        providerContext,
        command.runtimeMode,
        this.#selectedDriver(command.modelSelection),
      );
    }
    await this.#checkDispatchPreconditions(command);
    return this.#request<T>("/api/orchestration/dispatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command),
    });
  }

  async registerWorkflowMcpProviderSession(
    registration: T3WorkflowMcpProviderSession,
  ): Promise<void> {
    this.#requireAccessToken("register a workflow MCP provider session");
    await this.#request<void>("/api/mcp/provider-session", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(registration),
    });
  }

  #selectedDriver(modelSelection: unknown): unknown {
    if (typeof modelSelection !== "object" || modelSelection === null)
      return undefined;
    if (!("instanceId" in modelSelection)) return undefined;
    return modelSelection.instanceId;
  }

  async respondToApproval(
    threadId: string,
    requestId: string,
    decision: "accept" | "reject",
    commandId = globalThis.crypto.randomUUID(),
  ): Promise<{ sequence: number }> {
    return this.dispatch({
      type: "thread.approval.respond",
      commandId,
      threadId,
      requestId,
      decision: decision === "reject" ? "decline" : decision,
      createdAt: new Date().toISOString(),
    });
  }

  async respondToUserInput(
    threadId: string,
    requestId: string,
    answers: Record<string, string | string[]>,
    commandId = globalThis.crypto.randomUUID(),
  ): Promise<{ sequence: number }> {
    return this.dispatch({
      type: "thread.user-input.respond",
      commandId,
      threadId,
      requestId,
      answers,
      createdAt: new Date().toISOString(),
    });
  }

  async #checkDispatchPreconditions(command: T3DispatchCommand): Promise<void> {
    const threadCommands = new Set([
      "thread.turn.start",
      "thread.turn.interrupt",
      "thread.session.stop",
      "thread.approval.respond",
      "thread.user-input.respond",
    ]);
    if (!threadCommands.has(command.type)) return;
    if (!command.threadId)
      throw new T3PreconditionError(
        `Dispatch '${command.type}' requires threadId`,
      );

    const shell = await this.getShell();
    const shellThread = shell.threads.find(({ id }) => id === command.threadId);
    if (!shellThread)
      throw new T3PreconditionError(
        `Cannot dispatch '${command.type}': thread '${command.threadId}' does not exist`,
      );

    const requestKind =
      command.type === "thread.approval.respond"
        ? "approval.requested"
        : command.type === "thread.user-input.respond"
          ? "user-input.requested"
          : undefined;
    if (!requestKind) return;
    if (!command.requestId)
      throw new T3PreconditionError(
        `Dispatch '${command.type}' requires requestId`,
      );
    const requestIsPending =
      command.type === "thread.approval.respond"
        ? shellThread.hasPendingApprovals
        : shellThread.hasPendingUserInput;
    if (!requestIsPending)
      throw new T3PreconditionError(
        `Cannot dispatch '${command.type}': thread '${command.threadId}' has no pending request of the required kind`,
      );

    const snapshot = await this.getThread(command.threadId);
    const latestRequestedId = snapshot.thread.activities
      ?.filter(({ kind }) => kind === requestKind)
      .at(-1)?.payload?.requestId;
    if (latestRequestedId !== command.requestId)
      throw new T3PreconditionError(
        `Cannot dispatch '${command.type}': pending request '${command.requestId}' does not exist on thread '${command.threadId}'`,
      );
  }

  #requireAccessToken(operation: string): void {
    if (!this.#accessToken)
      throw new T3PreconditionError(
        `Cannot ${operation}: no T3 access token is configured`,
      );
  }

  async #request<T>(path: string, init: FetchRequestInit = {}): Promise<T> {
    const headers = new globalThis.Headers(init.headers);
    if (this.#accessToken)
      headers.set("authorization", `Bearer ${this.#accessToken}`);
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers,
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = text.length === 0 ? undefined : JSON.parse(text);
    } catch {
      body = text;
    }
    if (!response.ok)
      throw new T3HttpError(
        `T3 ${init.method ?? "GET"} ${path} failed with HTTP ${response.status}`,
        response.status,
        body,
      );
    return body as T;
  }
}
