// ---
// relationships:
//   implements: heddle
// ---

import { Buffer } from "node:buffer";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { URL } from "node:url";

import { buildKanbanProjection, parseConsoleScope } from "./projection.js";
import { consoleClient, consolePage, consoleStyles } from "./page.js";
import type { ConsoleBoard, ConsoleStateSource } from "./types.js";

export interface ConsoleServerOptions {
  board: ConsoleBoard;
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
            "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
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

const positiveInteger = (value: string): number => {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new RequestError("epic id must be a positive integer");
  }
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new RequestError("epic id must be a safe integer");
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

const readJsonBody = async (request: IncomingMessage): Promise<unknown> => {
  if (!request.headers["content-type"]?.startsWith("application/json")) {
    throw new RequestError("content-type must be application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1024) throw new RequestError("request body is too large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new RequestError("request body must be valid JSON");
  }
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
      if (url.pathname === "/api/board") {
        if (request.method !== "GET") return methodNotAllowed(response, "GET");
        const [statuses, tasks] = await Promise.all([
          options.board.readBoardStatuses(),
          options.board.readBoard(),
        ]);
        json(response, 200, { statuses, tasks });
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
        json(
          response,
          200,
          await options.state.listEvents({
            afterSequence: nonNegativeInteger(
              url.searchParams.get("after"),
              "after",
            ),
            ...(instanceId === null ? {} : { instanceId }),
          }),
        );
        return;
      }
      if (url.pathname === "/api/attention") {
        if (request.method !== "GET") return methodNotAllowed(response, "GET");
        json(response, 200, await options.state.listAttention());
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
      if (error instanceof RequestError) {
        json(response, 400, { error: error.message });
        return;
      }
      json(response, 500, { error: "console request failed" });
    }
  });
};
