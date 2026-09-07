// ---
// relationships:
//   implements: heddle
// ---

import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { URL } from "node:url";
import { MIMEType } from "node:util";

import { EpicStatusConflictError } from "../board-adapter/index.js";
import {
  BlueprintEditConflictError,
  BlueprintValidationError,
  RebaseInstanceNotAwaitingError,
  RebaseTargetNotAwaitableError,
  RebaseTargetNotFoundError,
  TransitionConflictError,
  type LifecycleEdge,
  type LifecycleNode,
} from "../engine/index.js";
import {
  buildKanbanProjection,
  ConsoleScopeError,
  parseConsoleScope,
  projectPublicBoardTask,
} from "./projection.js";
import {
  ConsoleAttentionActionsUnavailableError,
  ConsoleAttentionConflictError,
  isConsoleAttentionScope,
  MAXIMUM_CONSOLE_ATTENTION_IDENTIFIER_LENGTH,
  parseConsoleAttentionActionRequest,
  validateConsoleAttentionCatalog,
} from "./attention-contract.js";
import {
  buildDependencyGraphProjection,
  projectDependencyGraphAttention,
} from "./dependency-graph.js";
import {
  assertConsoleLifecycleRebaseCurrent,
  ConsoleLifecycleActionsUnavailableError,
  ConsoleLifecycleRebaseConflictError,
  parseConsoleLifecycleRebaseRequest,
} from "./lifecycle-rebase-contract.js";
import { projectPublicConsoleEvent } from "./event-projection.js";
import { consoleClient, consolePage, consoleStyles } from "./page.js";
import {
  assertConsoleTokenAbsent,
  ConsoleTokenDisclosureError,
} from "./token-disclosure.js";
import type {
  ConsoleAttention,
  ConsoleAttentionActionPort,
  ConsoleBoard,
  ConsoleLifecycleActionPort,
  ConsoleLifecycleSnapshot,
  ConsoleStateSource,
} from "./types.js";
import {
  ConsoleLifecycleNotStartedError,
  ConsoleLifecycleUnavailableError,
} from "./types.js";
import type { ConsoleBlueprintEditor } from "./blueprint-editor.js";

const lifecycleClient = readFileSync(
  new URL("../../assets/console-viewer/lifecycle.js", import.meta.url),
  "utf8",
);
const lifecycleStyles = readFileSync(
  new URL("../../assets/console-viewer/lifecycle.css", import.meta.url),
  "utf8",
);

export interface ConsoleServerOptions {
  actions?: ConsoleAttentionActionPort;
  board: ConsoleBoard;
  blueprintEditor?: ConsoleBlueprintEditor;
  lifecycleActions?: ConsoleLifecycleActionPort;
  now?: () => number;
  state: ConsoleStateSource;
}

class RequestError extends Error {}

const json = (
  response: ServerResponse,
  status: number,
  value: unknown,
): void => {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
};

const text = (
  response: ServerResponse,
  status: number,
  contentType: string,
  value: string,
): void => {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": `${contentType}; charset=utf-8`,
    ...(contentType === "text/html"
      ? {
          "content-security-policy":
            "default-src 'self'; script-src 'self'; style-src-elem 'self'; style-src-attr 'unsafe-inline'; font-src data:; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
          "x-content-type-options": "nosniff",
        }
      : {}),
  });
  response.end(value);
};

const nonNegativeInteger = (value: string | null, name: string): number => {
  if (value === null) return 0;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new RequestError(`${name} must be a non-negative integer`);
  }
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new RequestError(`${name} must be a safe integer`);
  }
  return result;
};

const positiveInteger = (value: string, name = "epic id"): number => {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new RequestError(`${name} must be a positive integer`);
  }
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new RequestError(`${name} must be a safe integer`);
  }
  return result;
};

const requestScope = (value: string | null) => {
  try {
    return parseConsoleScope(value);
  } catch (error) {
    throw new RequestError(
      error instanceof Error ? error.message : "scope is invalid",
    );
  }
};

const readJsonBody = async (
  request: IncomingMessage,
  maximumBytes = 1024,
): Promise<unknown> => {
  let mediaType: MIMEType;
  try {
    mediaType = new MIMEType(request.headers["content-type"] ?? "");
  } catch {
    throw new RequestError("content-type must be application/json");
  }
  if (mediaType.essence !== "application/json") {
    throw new RequestError("content-type must be application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumBytes)
      throw new RequestError("request body is too large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new RequestError("request body must be valid JSON");
  }
};

const requireBlueprintEdit = (
  value: unknown,
): {
  edges: LifecycleEdge[];
  expectedBlobHash: string;
  nodes: LifecycleNode[];
  positions: Record<string, { x: number; y: number }>;
} => {
  const candidate = value as Record<string, unknown>;
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !Array.isArray(candidate["nodes"]) ||
    !Array.isArray(candidate["edges"]) ||
    typeof candidate["expectedBlobHash"] !== "string" ||
    typeof candidate["positions"] !== "object" ||
    candidate["positions"] === null ||
    Array.isArray(candidate["positions"]) ||
    Object.keys(candidate).some(
      (key) =>
        !["edges", "expectedBlobHash", "nodes", "positions"].includes(key),
    )
  ) {
    throw new RequestError(
      "request body must contain only nodes, edges, positions, and expectedBlobHash",
    );
  }
  return value as {
    edges: LifecycleEdge[];
    expectedBlobHash: string;
    nodes: LifecycleNode[];
    positions: Record<string, { x: number; y: number }>;
  };
};

const requireEpicLever = (value: unknown): boolean => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("inProgress" in value) ||
    typeof value.inProgress !== "boolean" ||
    Object.keys(value).some((key) => key !== "inProgress")
  ) {
    throw new RequestError("request body must contain only boolean inProgress");
  }
  return value.inProgress;
};

const methodNotAllowed = (response: ServerResponse, allowed: string): void => {
  response.writeHead(405, { allow: allowed });
  response.end();
};

const decodePathSegment = (value: string, name: string): string => {
  try {
    const decoded = decodeURIComponent(value);
    if (
      decoded.trim() === "" ||
      decoded.length > MAXIMUM_CONSOLE_ATTENTION_IDENTIFIER_LENGTH
    ) {
      throw new RequestError(
        `${name} must be a non-empty string of at most ${MAXIMUM_CONSOLE_ATTENTION_IDENTIFIER_LENGTH} characters`,
      );
    }
    return decoded;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(`${name} is not valid URL encoding`);
  }
};

const readAttention = async (
  options: ConsoleServerOptions,
): Promise<ConsoleAttention[]> => {
  const attention = await options.state.listAttention();
  validateConsoleAttentionCatalog(attention, options.actions !== undefined);
  for (const entry of attention) {
    if (!isConsoleAttentionScope(entry.scope)) {
      throw new Error(`Attention '${entry.attentionId}' has an invalid scope`);
    }
  }
  return attention;
};

const readPublicAttention = async (
  options: ConsoleServerOptions,
): Promise<ConsoleAttention[]> => {
  const attention = await readAttention(options);
  const correlationTokens = await options.state.listCorrelationTokens();
  assertConsoleTokenAbsent(attention, correlationTokens);
  return attention;
};

const readPublicLifecycle = async (
  options: ConsoleServerOptions,
  input: { afterSequence: number; instanceId?: string; taskId: number },
): Promise<ConsoleLifecycleSnapshot> => {
  const lifecycle = await options.state.readLifecycle(input);
  const correlationTokens = await options.state.listCorrelationTokens();
  assertConsoleTokenAbsent(lifecycle, correlationTokens);
  return lifecycle;
};

export const createConsoleServer = (options: ConsoleServerOptions) => {
  const now = options.now ?? Date.now;
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://console.invalid");
      if (
        (url.pathname === "/" || url.pathname === "/index.html") &&
        request.method === "GET"
      ) {
        text(response, 200, "text/html", consolePage);
        return;
      }
      if (url.pathname === "/assets/console.css" && request.method === "GET") {
        text(response, 200, "text/css", consoleStyles);
        return;
      }
      if (url.pathname === "/assets/console.js" && request.method === "GET") {
        text(response, 200, "text/javascript", consoleClient);
        return;
      }
      if (
        url.pathname === "/assets/lifecycle.css" &&
        request.method === "GET"
      ) {
        text(response, 200, "text/css", lifecycleStyles);
        return;
      }
      if (url.pathname === "/assets/lifecycle.js" && request.method === "GET") {
        text(response, 200, "text/javascript", lifecycleClient);
        return;
      }
      if (url.pathname === "/api/board") {
        if (request.method !== "GET") return methodNotAllowed(response, "GET");
        const [statuses, tasks] = await Promise.all([
          options.board.readBoardStatuses(),
          options.board.readBoard(),
        ]);
        json(response, 200, {
          statuses,
          tasks: tasks.map(projectPublicBoardTask),
        });
        return;
      }
      if (url.pathname === "/api/instances") {
        if (request.method !== "GET") return methodNotAllowed(response, "GET");
        json(response, 200, await options.state.listInstances());
        return;
      }
      if (url.pathname === "/api/events") {
        if (request.method !== "GET") return methodNotAllowed(response, "GET");
        const instanceId = url.searchParams.get("instance");
        const events = await options.state.listEvents({
          afterSequence: nonNegativeInteger(
            url.searchParams.get("after"),
            "after",
          ),
          ...(instanceId === null ? {} : { instanceId }),
        });
        const correlationTokens = await options.state.listCorrelationTokens();
        json(
          response,
          200,
          events.map((event) =>
            projectPublicConsoleEvent(event, correlationTokens),
          ),
        );
        return;
      }
      if (url.pathname === "/api/attention") {
        if (request.method !== "GET") return methodNotAllowed(response, "GET");
        json(response, 200, await readPublicAttention(options));
        return;
      }
      const attentionAction =
        /^\/api\/attention\/([^/]+)\/actions\/([^/]+)$/.exec(url.pathname);
      if (attentionAction !== null) {
        if (request.method !== "POST")
          return methodNotAllowed(response, "POST");
        if (options.actions === undefined) {
          throw new ConsoleAttentionActionsUnavailableError(
            "Console attention actions are not active in this deployment composition",
          );
        }
        const attentionId = decodePathSegment(
          attentionAction[1]!,
          "attention id",
        );
        const actionId = decodePathSegment(attentionAction[2]!, "action id");
        const attention = (await readPublicAttention(options)).find(
          (entry) => entry.attentionId === attentionId,
        );
        if (attention === undefined) {
          throw new ConsoleAttentionConflictError(
            `Attention '${attentionId}' is no longer current`,
          );
        }
        const action = attention.actions.find(
          (candidate) => candidate.actionId === actionId,
        );
        if (action === undefined) {
          throw new ConsoleAttentionConflictError(
            `Action '${actionId}' is not offered by attention '${attentionId}'`,
          );
        }
        let input;
        try {
          input = parseConsoleAttentionActionRequest(
            await readJsonBody(request, 16 * 1024),
            action,
          );
        } catch (error) {
          throw new RequestError(
            error instanceof Error
              ? error.message
              : "attention action input is invalid",
          );
        }
        if (input.fingerprint !== attention.fingerprint) {
          throw new ConsoleAttentionConflictError(
            `Attention '${attentionId}' changed before action '${actionId}' executed`,
          );
        }
        await options.actions.execute({
          action,
          attention,
          ...(input.answers === undefined ? {} : { answers: input.answers }),
        });
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
        return;
      }
      if (url.pathname === "/api/projection") {
        if (request.method !== "GET") return methodNotAllowed(response, "GET");
        const [statuses, tasks, instances] = await Promise.all([
          options.board.readBoardStatuses(),
          options.board.readBoard(),
          options.state.listInstances(),
        ]);
        json(
          response,
          200,
          buildKanbanProjection({
            instances,
            now: now(),
            scope: requestScope(url.searchParams.get("scope")),
            statuses,
            tasks,
          }),
        );
        return;
      }
      if (url.pathname === "/api/dependency-graph") {
        if (request.method !== "GET") return methodNotAllowed(response, "GET");
        const [tasks, instances, attention] = await Promise.all([
          options.board.readBoard(),
          options.state.listInstances(),
          readAttention(options),
        ]);
        json(
          response,
          200,
          buildDependencyGraphProjection({
            attention: attention.map(projectDependencyGraphAttention),
            instances,
            scope: requestScope(url.searchParams.get("scope")),
            tasks,
          }),
        );
        return;
      }
      if (url.pathname === "/api/lifecycle") {
        if (request.method !== "GET") return methodNotAllowed(response, "GET");
        const lifecycle = await readPublicLifecycle(options, {
          afterSequence: nonNegativeInteger(
            url.searchParams.get("after"),
            "after",
          ),
          taskId: positiveInteger(
            url.searchParams.get("task") ?? "",
            "task id",
          ),
          ...(url.searchParams.get("instance") === null
            ? {}
            : {
                instanceId: decodePathSegment(
                  url.searchParams.get("instance")!,
                  "instance id",
                ),
              }),
        });
        json(response, 200, lifecycle);
        return;
      }
      const lifecycleRebase = /^\/api\/lifecycle\/([^/]+)\/rebase$/.exec(
        url.pathname,
      );
      if (lifecycleRebase !== null) {
        if (request.method !== "POST")
          return methodNotAllowed(response, "POST");
        if (options.lifecycleActions === undefined) {
          throw new ConsoleLifecycleActionsUnavailableError(
            "Console lifecycle actions are not active in this deployment composition",
          );
        }
        const taskId = positiveInteger(lifecycleRebase[1]!, "task id");
        let input;
        try {
          input = parseConsoleLifecycleRebaseRequest(
            await readJsonBody(request, 2048),
          );
        } catch (error) {
          throw new RequestError(
            error instanceof Error
              ? error.message
              : "lifecycle rebase input is invalid",
          );
        }
        const current = await readPublicLifecycle(options, {
          afterSequence: 0,
          taskId,
        });
        assertConsoleLifecycleRebaseCurrent(current, input);
        await options.lifecycleActions.rebase({
          instanceId: current.instanceId,
          targetState: input.targetState,
        });
        json(
          response,
          200,
          await readPublicLifecycle(options, { afterSequence: 0, taskId }),
        );
        return;
      }
      const blueprintArtifact = /^\/api\/blueprints\/([^/]+)$/.exec(
        url.pathname,
      );
      if (blueprintArtifact !== null) {
        if (options.blueprintEditor === undefined) {
          json(response, 503, {
            error:
              "Blueprint artifact editor is not active in this deployment composition",
          });
          return;
        }
        const artifactId = blueprintArtifact[1]!;
        if (request.method === "GET") {
          json(response, 200, await options.blueprintEditor.load(artifactId));
          return;
        }
        if (request.method === "PUT") {
          const edit = requireBlueprintEdit(
            await readJsonBody(request, 1024 * 1024),
          );
          json(
            response,
            200,
            await options.blueprintEditor.save({ artifactId, ...edit }),
          );
          return;
        }
        return methodNotAllowed(response, "GET, PUT");
      }
      const epicLever = /^\/api\/epics\/([^/]+)\/in-progress$/.exec(
        url.pathname,
      );
      if (epicLever !== null) {
        if (request.method !== "PUT") return methodNotAllowed(response, "PUT");
        const epicId = positiveInteger(epicLever[1]!);
        const inProgress = requireEpicLever(await readJsonBody(request));
        await options.board.setEpicInProgress(epicId, inProgress);
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
        return;
      }
      json(response, 404, { error: "not found" });
    } catch (error) {
      if (error instanceof RequestError || error instanceof ConsoleScopeError) {
        json(response, 400, { error: error.message });
        return;
      }
      if (error instanceof ConsoleLifecycleNotStartedError) {
        json(response, 404, {
          code: "lifecycle-not-started",
          error: error.message,
        });
        return;
      }
      if (error instanceof ConsoleLifecycleUnavailableError) {
        json(response, 503, { error: error.message });
        return;
      }
      if (error instanceof ConsoleTokenDisclosureError) {
        json(response, 503, { error: "Console data is unavailable" });
        return;
      }
      if (error instanceof ConsoleAttentionActionsUnavailableError) {
        json(response, 503, { error: error.message });
        return;
      }
      if (error instanceof ConsoleLifecycleActionsUnavailableError) {
        json(response, 503, { error: error.message });
        return;
      }
      if (error instanceof ConsoleAttentionConflictError) {
        json(response, 409, { error: error.message });
        return;
      }
      if (error instanceof EpicStatusConflictError) {
        json(response, 409, {
          code: "epic-status-conflict",
          error: error.message,
        });
        return;
      }
      if (
        error instanceof ConsoleLifecycleRebaseConflictError ||
        error instanceof TransitionConflictError ||
        error instanceof RebaseInstanceNotAwaitingError
      ) {
        json(response, 409, { error: error.message });
        return;
      }
      if (
        error instanceof RebaseTargetNotFoundError ||
        error instanceof RebaseTargetNotAwaitableError
      ) {
        json(response, 422, { error: error.message });
        return;
      }
      if (error instanceof BlueprintEditConflictError) {
        json(response, 409, { error: error.message });
        return;
      }
      if (error instanceof BlueprintValidationError) {
        json(response, 422, { error: error.message });
        return;
      }
      json(response, 500, { error: "console request failed" });
    }
  });
};
