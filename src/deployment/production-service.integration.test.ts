// ---
// relationships:
//   verifies: heddle
// ---

import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { Buffer } from "node:buffer";
import { createServer, type Server as HttpServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { URL } from "node:url";
import { promisify } from "node:util";
import type { Duplex } from "node:stream";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";

import { prepareProductionFixture } from "../production/composition.test-support.js";

const execute = promisify(execFile);

const waitFor = async (
  assertion: () => Promise<void>,
  timeoutMilliseconds = 10_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => globalThis.setTimeout(resolve, 25));
    }
  }
  throw lastError;
};

const listen = async (server: HttpServer): Promise<number> => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test HTTP server did not bind a TCP port");
  }
  return address.port;
};

const closeServer = async (server: HttpServer | undefined): Promise<void> => {
  if (server === undefined || !server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
};

const webSocketTextFrame = (value: unknown): Buffer => {
  const payload = Buffer.from(JSON.stringify(value));
  if (payload.length >= 126) {
    const frame = Buffer.allocUnsafe(payload.length + 4);
    frame[0] = 0x81;
    frame[1] = 126;
    frame.writeUInt16BE(payload.length, 2);
    payload.copy(frame, 4);
    return frame;
  }
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
};

const readMaskedWebSocketText = (source: Buffer): string | undefined => {
  if (source.length < 6 || (source[0]! & 0x0f) !== 1) return undefined;
  const encodedLength = source[1]! & 0x7f;
  let offset = 2;
  let length = encodedLength;
  if (encodedLength === 126) {
    if (source.length < 8) return undefined;
    length = source.readUInt16BE(offset);
    offset += 2;
  }
  const mask = source.subarray(offset, offset + 4);
  offset += 4;
  if (source.length < offset + length) return undefined;
  const payload = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index += 1) {
    payload[index] = source[offset + index]! ^ mask[index % 4]!;
  }
  return payload.toString("utf8");
};

const acceptProviderCatalogSocket = (
  socket: Duplex,
  webSocketKey: string,
  onRequest: (request: Record<string, unknown>) => void,
): void => {
  const accept = createHash("sha1")
    .update(`${webSocketKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.once("data", (chunk: Buffer) => {
    const source = readMaskedWebSocketText(chunk);
    if (source === undefined) {
      socket.destroy(new Error("Incomplete provider catalog request frame"));
      return;
    }
    const request = JSON.parse(source) as Record<string, unknown>;
    onRequest(request);
    socket.write(
      webSocketTextFrame({
        _tag: "Exit",
        requestId: request["id"],
        exit: {
          _tag: "Success",
          value: {
            providers: [
              {
                availability: "available",
                displayName: "Workbench Alpha",
                driver: "claudeAgent",
                enabled: true,
                installed: true,
                instanceId: "provider-alpha",
                models: [
                  {
                    isCustom: false,
                    name: "Sample Model",
                    slug: "sample-model",
                  },
                ],
                status: "ready",
                version: "2.1.250",
              },
            ],
          },
        },
      }),
      () => socket.end(),
    );
  });
};

describe("configured production service entry point", () => {
  let fixture: Awaited<ReturnType<typeof prepareProductionFixture>> | undefined;
  let t3Server: HttpServer | undefined;
  let service: ChildProcessWithoutNullStreams | undefined;
  let mcpClient: Client | undefined;

  afterEach(async () => {
    await mcpClient?.close();
    if (service?.exitCode === null && service.signalCode === null) {
      service.kill("SIGKILL");
      await new Promise<void>((resolve) =>
        service!.once("exit", () => resolve()),
      );
    }
    await closeServer(t3Server);
    await fixture?.cleanup();
  });

  it("runs scheduler, lifecycle resume, and token-authenticated MCP from config.yml only", async () => {
    fixture = await prepareProductionFixture();
    const configurationDirectory = join(fixture.root, "configuration");
    const configurationPath = join(configurationDirectory, "config.yml");
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(configurationDirectory, { recursive: true }),
    );
    const { stdout: blueprintOrigin } = await execute(
      "git",
      ["remote", "get-url", "origin"],
      { cwd: fixture.blueprintsRepositoryRoot },
    );
    await execute(
      "git",
      [
        "clone",
        "--quiet",
        "--branch",
        "main",
        blueprintOrigin.trim(),
        join(configurationDirectory, "blueprints"),
      ],
      { cwd: configurationDirectory },
    );
    const threads = new Set<string>();
    const projects = new Map<
      string,
      { id: string; title: string; workspaceRoot: string }
    >();
    const commands: Array<Record<string, unknown>> = [];
    const registrations: Array<Record<string, unknown>> = [];
    const catalogRequests: Array<Record<string, unknown>> = [];
    t3Server = createServer(async (request, response) => {
      expect(request.headers.authorization).toBe("Bearer t3-secret-value");
      response.setHeader("content-type", "application/json");
      if (
        request.method === "POST" &&
        request.url === "/api/auth/websocket-ticket"
      ) {
        response.end(
          JSON.stringify({
            expiresAt: "2026-09-07T00:05:00.000Z",
            ticket: "isolated-ticket",
          }),
        );
        return;
      }
      if (
        request.method === "GET" &&
        request.url === "/api/orchestration/shell"
      ) {
        response.end(
          JSON.stringify({
            projects: [...projects.values()],
            threads: [...threads].map((id) => ({
              id,
              latestTurn: { state: "running" },
              session: { status: "running" },
            })),
          }),
        );
        return;
      }
      if (
        request.method === "GET" &&
        request.url?.startsWith("/api/orchestration/threads/")
      ) {
        response.end(JSON.stringify({ thread: { activities: [] } }));
        return;
      }
      if (
        request.method === "PUT" &&
        request.url === "/api/mcp/provider-session"
      ) {
        let source = "";
        request.setEncoding("utf8");
        for await (const chunk of request) source += chunk;
        registrations.push(JSON.parse(source) as Record<string, unknown>);
        response.statusCode = 204;
        response.end();
        return;
      }
      if (
        request.method === "POST" &&
        request.url === "/api/orchestration/dispatch"
      ) {
        let source = "";
        request.setEncoding("utf8");
        for await (const chunk of request) source += chunk;
        const command = JSON.parse(source) as Record<string, unknown>;
        commands.push(command);
        if (command["type"] === "project.create") {
          projects.set(String(command["projectId"]), {
            id: String(command["projectId"]),
            title: String(command["title"]),
            workspaceRoot: String(command["workspaceRoot"]),
          });
        }
        if (command["type"] === "thread.create") {
          threads.add(String(command["threadId"]));
        }
        response.end(JSON.stringify({ sequence: commands.length }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    });
    t3Server.on("upgrade", (request, socket) => {
      expect(request.url).toBe("/ws?wsTicket=isolated-ticket");
      const key = request.headers["sec-websocket-key"];
      if (typeof key !== "string") {
        socket.destroy(new Error("Missing WebSocket key"));
        return;
      }
      acceptProviderCatalogSocket(socket, key, (rpc) => {
        catalogRequests.push(rpc);
      });
    });
    const t3Port = await listen(t3Server);

    const portProbe = createServer();
    const servicePort = await listen(portProbe);
    await closeServer(portProbe);
    const { defaultProvider: _defaultProvider, ...configuredPacing } =
      fixture.configuration.pacing;
    const {
      defaultSelection: _defaultSelection,
      resolvedSelections: _resolvedSelections,
      ...configuredSession
    } = fixture.configuration.session;
    void _defaultProvider;
    void _defaultSelection;
    void _resolvedSelections;
    const configured = {
      ...fixture.configuration,
      pacing: configuredPacing,
      server: { host: "127.0.0.1", port: servicePort },
      session: configuredSession,
      t3: {
        accessToken: "t3-secret-value",
        baseUrl: `http://127.0.0.1:${t3Port}`,
      },
    };
    await writeFile(configurationPath, stringify(configured));

    service = spawn(
      process.execPath,
      ["bin/heddle-server.mjs", "--config", configurationDirectory],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HEDDLE_BOARD_PATH: "/tmp/deprecated-board-must-not-be-read",
          HEDDLE_CONFIG: "/tmp/deprecated-config-must-not-be-read",
          HEDDLE_HOST: "192.0.2.50",
          HEDDLE_PORT: "1",
          HEDDLE_STATE_PATH: "/tmp/deprecated-state-must-not-be-read",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let standardOutput = "";
    let standardError = "";
    service.stdout.setEncoding("utf8");
    service.stderr.setEncoding("utf8");
    service.stdout.on("data", (chunk: string) => {
      standardOutput += chunk;
    });
    service.stderr.on("data", (chunk: string) => {
      standardError += chunk;
    });
    const origin = `http://127.0.0.1:${servicePort}`;
    await waitFor(async () => {
      const response = await globalThis.fetch(`${origin}/api/instances`, {
        signal: globalThis.AbortSignal.timeout(500),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([
        expect.objectContaining({
          instanceId: `task-${fixture!.taskId}`,
          stageId: "implement",
          taskId: fixture!.taskId,
        }),
      ]);
    });

    expect(catalogRequests).toEqual([
      expect.objectContaining({
        _tag: "Request",
        payload: {},
        tag: "server.getConfig",
      }),
      expect.objectContaining({
        _tag: "Request",
        payload: {},
        tag: "server.getConfig",
      }),
      expect.objectContaining({
        _tag: "Request",
        payload: {},
        tag: "server.getConfig",
      }),
    ]);
    expect(commands.map((command) => command["type"]).slice(0, 3)).toEqual([
      "project.create",
      "thread.create",
      "thread.turn.start",
    ]);
    expect(commands[1]).toMatchObject({
      modelSelection: {
        instanceId: "provider-alpha",
        model: "sample-model",
      },
    });

    const database = new Database(
      join(fixture.configuration.stateDirectory, "heddle-state.sqlite"),
      { readonly: true },
    );
    const indexed = database
      .prepare(
        `SELECT token, instance_id AS instanceId, session_key AS sessionKey
           FROM heddle_correlation_tokens
           ORDER BY session_key
           LIMIT 1`,
      )
      .get() as { instanceId: string; sessionKey: string; token: string };
    database.close();
    expect(indexed.instanceId).toBe(`task-${fixture.taskId}`);
    const registration = registrations[0]!;
    const createdThread = commands.find(
      (command) => command["type"] === "thread.create",
    );
    expect(registrations).toHaveLength(1);
    expect(registration["endpoint"]).toBe(`${origin}/mcp`);
    expect(registration["threadId"]).toBe(createdThread?.["threadId"]);
    expect(registration["authorizationHeader"]).toMatch(/^Bearer \S+$/);
    const registeredToken = String(registration["authorizationHeader"]).slice(
      "Bearer ".length,
    );
    expect(createHash("sha256").update(registeredToken).digest("hex")).toBe(
      createHash("sha256").update(indexed.token).digest("hex"),
    );
    const firstTurn = commands.find(
      (command) => command["type"] === "thread.turn.start",
    );
    expect(JSON.stringify(firstTurn)).not.toContain(indexed.token);

    mcpClient = new Client({ name: "configured-service", version: "1.0.0" });
    await mcpClient.connect(
      new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
        authProvider: { token: async () => indexed.token },
      }),
    );
    expect(
      (await mcpClient.listTools()).tools.map(({ name }) => name),
    ).toContain("advance");
    await expect(
      mcpClient.callTool({
        name: "advance",
        arguments: { disposition: "complete" },
      }),
    ).resolves.toMatchObject({
      structuredContent: { awaitingNodeIds: ["review"] },
    });
    await mcpClient.close();
    mcpClient = undefined;

    const lifecycle = await globalThis.fetch(
      `${origin}/api/lifecycle?task=${fixture.taskId}&after=0`,
    );
    expect(lifecycle.status).toBe(200);
    await expect(lifecycle.json()).resolves.toMatchObject({
      currentStageIds: ["review"],
      instanceId: `task-${fixture.taskId}`,
    });

    service.kill("SIGTERM");
    const exitCode = await new Promise<number | null>((resolve) =>
      service!.once("exit", (code) => resolve(code)),
    );
    expect(exitCode).toBe(0);
    expect(standardOutput).toBe("");
    expect(standardError).toBe("");
    const persisted = await readFile(
      join(fixture.configuration.stateDirectory, "heddle-state.sqlite"),
    );
    const disclosureSurface = `${standardOutput}${standardError}${persisted.toString("latin1")}`;
    expect(disclosureSurface).not.toContain("t3-secret-value");
    expect(disclosureSurface).not.toContain("application-token");
    expect(disclosureSurface).not.toContain("operator-key");
    expect(disclosureSurface).not.toContain("deprecated-");
  }, 20_000);
});
