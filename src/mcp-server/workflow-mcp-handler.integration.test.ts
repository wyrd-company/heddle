// ---
// relationships:
//   verifies: heddle
// ---

import { execFile } from "node:child_process";
import { createServer, type Server as HttpServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { afterEach, describe, expect, it, vi } from "vitest";

import { assembleStageHandoff } from "../control-plane/index.js";
import {
  LifecycleEngine,
  type LifecycleBlueprint,
  type LifecycleEffect,
} from "../engine/index.js";
import { SqlitePersistence } from "../persistence/index.js";
import { createWorkflowMcpHttpHandler } from "./workflow-mcp-handler.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const httpServers: HttpServer[] = [];
const clients: Client[] = [];

type HttpObservation = {
  contentType: string | null;
  method: string;
  sessionId: string | null;
  status: number;
};

const blueprint = (
  tools: string[],
  acceptDescription: string,
): LifecycleBlueprint => ({
  id: "sample-process",
  nodes: [
    { id: "prepare", uses: "prepare" },
    { id: "assess", uses: "wait", tools },
    { id: "inspect", uses: "wait", tools: ["get_task_context"] },
    { id: "accepted", uses: "accepted" },
    { id: "revised", uses: "revised" },
  ],
  edges: [
    { source: "prepare", target: "assess" },
    {
      condition: "result.output.dispositions.accept",
      description: acceptDescription,
      disposition: "accept",
      source: "assess",
      target: "accepted",
    },
    {
      condition: "result.output.dispositions.revise",
      description: "Return the sample for another preparation",
      disposition: "revise",
      source: "assess",
      target: "inspect",
    },
    {
      condition: "result.output.dispositions.complete",
      description: "Complete inspection of the revised sample",
      disposition: "complete",
      source: "inspect",
      target: "revised",
    },
  ],
});

const writeBlueprint = async (
  repositoryRoot: string,
  name: string,
  value: LifecycleBlueprint,
): Promise<string> => {
  const path = `blueprints/${name}.json`;
  const artifact = { ...value } as Partial<LifecycleBlueprint>;
  delete artifact.id;
  await writeFile(join(repositoryRoot, path), JSON.stringify(artifact));
  return path;
};

const storedHandoff = (
  sessionKey: string,
  token: string,
  taskContract: Record<string, string | number>,
) => {
  const handoff = assembleStageHandoff({
    correlationToken: token,
    skillPointer: "skills/sample.md",
    stage: {
      kind: "standard",
      name: "assess",
      priorStageOutputs: [],
    },
    taskContract,
    todoList: null,
  });
  return {
    correlationToken: token,
    handoff,
    kind: "stage-handoff" as const,
    sessionKey,
  };
};

const listen = async (
  handler: ReturnType<typeof createWorkflowMcpHttpHandler>,
): Promise<globalThis.URL> => {
  const nodeHandler = toNodeHandler(handler);
  const server = createServer((request, response) => {
    void nodeHandler(request, response);
  });
  httpServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("HTTP test server did not bind a TCP port");
  }
  return new globalThis.URL(`http://127.0.0.1:${address.port}/mcp`);
};

const connect = async (
  url: globalThis.URL,
  token: string,
  name: string,
  observations?: HttpObservation[],
): Promise<Client> => {
  const client = new Client({ name, version: "1.0.0" });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      authProvider: { token: async () => token },
      fetch: async (input, init) => {
        const response = await globalThis.fetch(input, init);
        observations?.push({
          contentType: response.headers.get("content-type"),
          method:
            init?.method ??
            (input instanceof globalThis.Request ? input.method : "GET"),
          sessionId: response.headers.get("mcp-session-id"),
          status: response.status,
        });
        return response;
      },
    }),
  );
  return client;
};

const makeFixture = async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "heddle-mcp-"));
  temporaryDirectories.push(repositoryRoot);
  await execFileAsync("git", ["init", "--quiet"], { cwd: repositoryRoot });
  await mkdir(join(repositoryRoot, "blueprints"));
  const alphaPath = await writeBlueprint(
    repositoryRoot,
    "alpha-sample",
    blueprint(["advance", "get_task_context"], "Accept the prepared sample"),
  );
  const betaPath = await writeBlueprint(
    repositoryRoot,
    "beta-sample",
    blueprint(["get_task_context", "report_blocked"], "Accept the sample"),
  );
  const persistence = new SqlitePersistence({
    stateDirectory: join(repositoryRoot, "state"),
  });
  const accepted = vi.fn<LifecycleEffect>(async () => ({ accepted: true }));
  const effect =
    (name: string): LifecycleEffect =>
    async () => ({ name });
  const lifecycle = new LifecycleEngine({
    effects: {
      accepted,
      prepare: effect("prepare"),
      revised: effect("revised"),
    },
    persistence,
    repositoryRoot,
  });

  const alphaToken = "token-alpha";
  const betaToken = "token-beta";
  await lifecycle.start({
    blueprintPath: alphaPath,
    instanceId: "instance-alpha",
    state: {
      correlationTokens: { "stage-alpha": alphaToken },
      handoffs: [
        storedHandoff("stage-alpha", alphaToken, {
          id: 11,
          title: "Prepare a sample",
        }),
      ],
      todoState: null,
    },
  });
  await lifecycle.start({
    blueprintPath: betaPath,
    instanceId: "instance-beta",
    state: {
      correlationTokens: { "stage-beta": betaToken },
      handoffs: [
        storedHandoff("stage-beta", betaToken, {
          id: 12,
          title: "Assess a sample",
        }),
      ],
      todoState: null,
    },
  });

  const handler = createWorkflowMcpHttpHandler({
    lifecycle,
    persistence,
    repositoryRoot,
  });
  const url = await listen(handler);
  return {
    accepted,
    alphaToken,
    betaToken,
    handler,
    lifecycle,
    persistence,
    url,
  };
};

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(
    httpServers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) =>
              error === undefined ? resolve() : reject(error),
            ),
          ),
      ),
  );
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("workflow MCP HTTP server", () => {
  it("returns plain JSON for a stateless MCP POST", async () => {
    const fixture = await makeFixture();
    const response = await globalThis.fetch(fixture.url, {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "sample-client", version: "1.0.0" },
          protocolVersion: "2025-11-25",
        },
      }),
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${fixture.alphaToken}`,
        "content-type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("mcp-session-id")).toBeNull();
    await response.body?.cancel();
  });

  it("connects Claude Code and Codex without an MCP session", async () => {
    const fixture = await makeFixture();

    for (const clientName of ["claude-code", "codex"]) {
      const observations: HttpObservation[] = [];
      const client = await connect(
        fixture.url,
        fixture.alphaToken,
        clientName,
        observations,
      );
      await expect(client.listTools()).resolves.toMatchObject({
        tools: [{ name: "advance" }, { name: "get_task_context" }],
      });
      const successfulRequests = observations.filter(
        ({ method, status }) => method === "POST" && status === 200,
      );
      expect(successfulRequests.length).toBeGreaterThanOrEqual(2);
      expect(successfulRequests).toEqual(
        successfulRequests.map(() => ({
          contentType: "application/json",
          method: "POST",
          sessionId: null,
          status: 200,
        })),
      );
    }
  });

  it("rejects a token handoff that names a different workflow stage", async () => {
    const fixture = await makeFixture();
    const record = fixture.persistence.getInstance("instance-alpha");
    if (record === undefined) throw new Error("alpha fixture is missing");
    const stored = record.state.handoffs[0];
    if (
      typeof stored !== "object" ||
      stored === null ||
      Array.isArray(stored) ||
      typeof stored["handoff"] !== "string"
    ) {
      throw new Error("alpha handoff fixture is invalid");
    }
    const handoff = JSON.parse(stored["handoff"]) as {
      stage: { name: string };
    };
    handoff.stage.name = "inspect";
    fixture.persistence.updateInstance("instance-alpha", {
      ...record.state,
      handoffs: [{ ...stored, handoff: JSON.stringify(handoff) }],
    });

    await expect(
      connect(fixture.url, fixture.alphaToken, "mismatched-client"),
    ).rejects.toThrow();
  });

  it("rejects a handoff document carrying a different correlation token", async () => {
    const fixture = await makeFixture();
    const record = fixture.persistence.getInstance("instance-alpha");
    if (record === undefined) throw new Error("alpha fixture is missing");
    const stored = record.state.handoffs[0];
    if (
      typeof stored !== "object" ||
      stored === null ||
      Array.isArray(stored) ||
      typeof stored["handoff"] !== "string"
    ) {
      throw new Error("alpha handoff fixture is invalid");
    }
    const handoff = JSON.parse(stored["handoff"]) as {
      correlationToken: string;
    };
    handoff.correlationToken = "token-mismatch";
    fixture.persistence.updateInstance("instance-alpha", {
      ...record.state,
      handoffs: [{ ...stored, handoff: JSON.stringify(handoff) }],
    });

    await expect(
      connect(fixture.url, fixture.alphaToken, "mismatched-client"),
    ).rejects.toThrow();
  });

  it("rejects a correlation token that matches more than one instance", async () => {
    const fixture = await makeFixture();
    const beta = fixture.persistence.getInstance("instance-beta");
    if (beta === undefined) throw new Error("beta fixture is missing");
    fixture.persistence.updateInstance("instance-beta", {
      ...beta.state,
      correlationTokens: { "stage-beta": fixture.alphaToken },
    });

    const response = await globalThis.fetch(fixture.url, {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "sample-client", version: "1.0.0" },
          protocolVersion: "2025-11-25",
        },
      }),
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${fixture.alphaToken}`,
        "content-type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("derives a static, omission-based tool list and disposition descriptions", async () => {
    const fixture = await makeFixture();
    const alpha = await connect(
      fixture.url,
      fixture.alphaToken,
      "alpha-client",
    );
    const beta = await connect(fixture.url, fixture.betaToken, "beta-client");

    const alphaTools = await alpha.listTools();
    const betaTools = await beta.listTools();
    expect(alphaTools.tools.map(({ name }) => name)).toEqual([
      "advance",
      "get_task_context",
    ]);
    expect(betaTools.tools.map(({ name }) => name)).toEqual([
      "get_task_context",
      "report_blocked",
    ]);
    expect(JSON.stringify(alphaTools.tools[0]?.inputSchema)).toContain(
      "Accept the prepared sample",
    );
    expect(JSON.stringify(alphaTools.tools[0]?.inputSchema)).toContain(
      "Return the sample for another preparation",
    );
    const advanceSchema = alphaTools.tools[0]?.inputSchema as {
      properties?: {
        disposition?: { anyOf?: Array<{ const?: unknown }> };
      };
    };
    expect(
      advanceSchema.properties?.disposition?.anyOf?.map(
        (option) => option.const,
      ),
    ).toEqual(["accept", "revise"]);
    await expect(
      alpha.callTool({
        name: "advance",
        arguments: { disposition: "archive" },
      }),
    ).resolves.toMatchObject({ isError: true });
  });

  it("binds task context and blocked reports to the token's instance", async () => {
    const fixture = await makeFixture();
    const beta = await connect(fixture.url, fixture.betaToken, "beta-client");

    await expect(
      beta.callTool({ name: "get_task_context", arguments: {} }),
    ).resolves.toMatchObject({
      structuredContent: {
        taskContext: { id: 12, title: "Assess a sample" },
      },
    });
    await expect(
      beta.callTool({
        name: "report_blocked",
        arguments: { message: "A required input is unavailable" },
      }),
    ).resolves.toMatchObject({
      structuredContent: { recorded: true },
    });
    expect(
      fixture.persistence
        .replayEvents("instance-beta")
        .filter(({ type }) => type === "mcp:blocked-reported"),
    ).toMatchObject([
      {
        instanceId: "instance-beta",
        payload: {
          message: "A required input is unavailable",
          sessionKey: "stage-beta",
          stage: "assess",
        },
      },
    ]);
    expect(
      fixture.persistence
        .replayEvents("instance-alpha")
        .some(({ type }) => type === "mcp:blocked-reported"),
    ).toBe(false);
  });

  it("rejects instance injection and advances only the token-bound instance", async () => {
    const fixture = await makeFixture();
    const alpha = await connect(
      fixture.url,
      fixture.alphaToken,
      "alpha-client",
    );
    const betaBefore = fixture.persistence.getInstance("instance-beta");

    await expect(
      alpha.callTool({
        name: "advance",
        arguments: {
          disposition: "accept",
          instanceId: "instance-beta",
        },
      }),
    ).resolves.toMatchObject({ isError: true });
    expect(fixture.persistence.getInstance("instance-beta")).toEqual(
      betaBefore,
    );

    await expect(
      alpha.callTool({
        name: "advance",
        arguments: {
          disposition: "accept",
          output: { instanceId: "instance-beta" },
        },
      }),
    ).resolves.toMatchObject({
      structuredContent: { instanceId: "instance-alpha", status: "completed" },
    });
    expect(fixture.persistence.getInstance("instance-beta")).toEqual(
      betaBefore,
    );
  });

  it("replays advance idempotently for the same instance stage", async () => {
    const fixture = await makeFixture();
    const alpha = await connect(
      fixture.url,
      fixture.alphaToken,
      "alpha-client",
    );
    const input = {
      name: "advance",
      arguments: { disposition: "accept" },
    };

    const first = await alpha.callTool(input);
    const retryClient = await connect(
      fixture.url,
      fixture.alphaToken,
      "retry-client",
    );
    await expect(retryClient.listTools()).resolves.toMatchObject({
      tools: [{ name: "advance" }, { name: "get_task_context" }],
    });
    const second = await alpha.callTool(input);

    expect(second.structuredContent).toEqual(first.structuredContent);
    expect(fixture.accepted).toHaveBeenCalledTimes(1);
  });
});
