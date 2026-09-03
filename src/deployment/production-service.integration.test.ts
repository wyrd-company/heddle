// ---
// relationships:
//   verifies: heddle
// ---

import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createServer, type Server as HttpServer } from "node:http";
import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { URL } from "node:url";
import { promisify } from "node:util";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";

import { prepareProductionFixture } from "../production/composition.test-support.js";

const execute = promisify(execFile);

const timeoutCommand = `
import { appendFileSync, writeFileSync } from "node:fs";

const [requestPath, orderPath] = process.argv.slice(2);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  JSON.parse(input);
  writeFileSync(requestPath, input);
  appendFileSync(orderPath, "timeout-applied\\n");
  process.stdout.write(JSON.stringify({ version: 1, applied: true }) + "\\n");
});
`;

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

  it("runs scheduler, timeout-before-thread, lifecycle resume, and token-authenticated MCP from config.yml only", async () => {
    fixture = await prepareProductionFixture();
    const configurationDirectory = join(fixture.root, "configuration");
    const configurationPath = join(configurationDirectory, "config.yml");
    const timeoutScript = join(fixture.root, "timeout-command.mjs");
    const timeoutRequestPath = join(fixture.root, "timeout-request.json");
    const orderPath = join(fixture.root, "dispatch-order.txt");
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
    await writeFile(timeoutScript, timeoutCommand);
    await writeFile(orderPath, "");

    const threads = new Set<string>();
    const commands: Array<Record<string, unknown>> = [];
    const registrations: Array<Record<string, unknown>> = [];
    t3Server = createServer(async (request, response) => {
      expect(request.headers.authorization).toBe("Bearer t3-secret-value");
      response.setHeader("content-type", "application/json");
      if (
        request.method === "GET" &&
        request.url === "/api/orchestration/shell"
      ) {
        response.end(
          JSON.stringify({
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
        await appendFile(orderPath, "mcp-registered\n");
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
        if (command["type"] === "thread.create") {
          threads.add(String(command["threadId"]));
          await appendFile(orderPath, "thread-created\n");
        }
        response.end(JSON.stringify({ sequence: commands.length }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    });
    const t3Port = await listen(t3Server);

    const portProbe = createServer();
    const servicePort = await listen(portProbe);
    await closeServer(portProbe);
    const configured = {
      ...fixture.configuration,
      pacing: {
        ...fixture.configuration.pacing,
        defaultProvider: "claudeAgent",
      },
      server: { host: "127.0.0.1", port: servicePort },
      session: {
        ...fixture.configuration.session,
        cliVersion: "2.1.250",
        driver: "claudeAgent",
        timeoutApplication: {
          arguments: [timeoutScript, timeoutRequestPath, orderPath],
          executable: process.execPath,
          timeoutMilliseconds: 2_000,
        },
      },
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
      const response = await globalThis.fetch(`${origin}/api/instances`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([
        expect.objectContaining({
          instanceId: `task-${fixture!.taskId}`,
          stageId: "implement",
          taskId: fixture!.taskId,
        }),
      ]);
    });

    expect((await readFile(orderPath, "utf8")).split("\n").slice(0, 3)).toEqual(
      ["timeout-applied", "mcp-registered", "thread-created"],
    );
    const timeoutRequest = JSON.parse(
      await readFile(timeoutRequestPath, "utf8"),
    ) as Record<string, unknown>;
    expect(timeoutRequest).toMatchObject({
      configuration: {
        environment: { MCP_TOOL_TIMEOUT: "100000000" },
      },
      driver: "claudeAgent",
      version: 1,
    });
    expect(commands.map((command) => command["type"]).slice(0, 2)).toEqual([
      "thread.create",
      "thread.turn.start",
    ]);

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
