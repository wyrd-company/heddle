// ---
// relationships:
//   verifies: heddle
// ---

import { execFile, spawn } from "node:child_process";
import { createServer, type Server as HttpServer } from "node:http";
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cwd, env } from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { promisify } from "node:util";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assembleStageHandoff,
  bootstrapStageSession,
  GitHandoffTemplateStore,
} from "../control-plane/index.js";
import {
  LifecycleEngine,
  type LifecycleBlueprint,
  type LifecycleEffect,
} from "../engine/index.js";
import { writeDeliveryBlueprintFixture } from "../engine/lifecycle-blueprint.test-support.js";
import { SqlitePersistence } from "../persistence/index.js";
import { resolvedSessionBindingFixture } from "../persistence/resolved-session-binding.test-support.js";
import {
  claimTodoAssignment,
  mutateTodoAssignment,
  stopTodoAssignmentTree,
  type SubagentCoordinator,
} from "../subagents/index.js";
import { createWorkflowMcpHttpHandler } from "./workflow-mcp-handler.js";

const registerWorkflowMcpProviderSession = async (): Promise<void> => undefined;
const workflowMcpEndpoint = "http://127.0.0.1:4774/mcp";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const httpServers: HttpServer[] = [];
const clients: Client[] = [];
const claudeHarnessTest =
  env["HEDDLE_MCP_CLAUDE_INTEGRATION"] === "1" ? it : it.skip;
const codexHarnessTest =
  env["HEDDLE_MCP_CODEX_INTEGRATION"] === "1" ? it : it.skip;

const sampleHandoffTemplate = `---
$schema: https://wyrd.company/heddle/handoff-template.schema.json
relationships:
  implements: heddle
format: heddle.handoff-template
version: 1
kind: standard
---
# {{ task.title }}

Stage: {{ handoff.stage.name }}
`;

type HttpObservation = {
  contentType: string | null;
  method: string;
  sessionId: string | null;
  status: number;
};

const runHarness = (
  command: string,
  arguments_: string[],
  options: {
    cwd: string;
    env?: Record<string, string | undefined>;
    timeout: number;
  },
): Promise<{ stderr: string; stdout: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    child.stderr.setEncoding("utf8");
    child.stdout.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    const timeout = setTimeout(() => child.kill("SIGTERM"), options.timeout);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve({ stderr, stdout });
      else reject(new Error(`${command} exited ${code}: ${stderr}`));
    });
  });

const blueprint = (
  tools: string[],
  acceptDescription: string,
  handoffTemplateCommitSha: string,
  acceptDisposition = "accept",
): LifecycleBlueprint => ({
  id: "sample-process",
  nodes: [
    { id: "prepare", uses: "prepare" },
    {
      id: "assess",
      handoff: "standard",
      "handoff-template": {
        commitSha: handoffTemplateCommitSha,
        path: "handoff-templates/standard.md",
      },
      uses: "wait",
      tools,
      "todo-template": "sample-stage",
    },
    {
      id: "inspect",
      handoff: "standard",
      "handoff-template": {
        commitSha: handoffTemplateCommitSha,
        path: "handoff-templates/standard.md",
      },
      uses: "wait",
      tools: ["get_task_context"],
      "todo-template": "sample-stage",
    },
    { id: "accepted", uses: "accepted" },
    { id: "revised", uses: "revised" },
  ],
  edges: [
    { source: "prepare", target: "assess" },
    {
      condition: `result.output.dispositions.${acceptDisposition}`,
      description: acceptDescription,
      disposition: acceptDisposition,
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
  await mkdir(join(repositoryRoot, "handoff-templates"));
  await mkdir(join(repositoryRoot, "todo-templates"));
  await writeFile(
    join(repositoryRoot, "todo-templates", "sample-stage.json"),
    JSON.stringify({
      items: [{ id: "orient", text: "Orient on {{task.title}}" }],
    }),
  );
  await writeFile(
    join(repositoryRoot, "handoff-templates", "standard.md"),
    sampleHandoffTemplate,
  );
  await execFileAsync(
    "git",
    [
      "add",
      "handoff-templates/standard.md",
      "todo-templates/sample-stage.json",
    ],
    { cwd: repositoryRoot },
  );
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Sample User",
      "-c",
      "user.email=sample@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "add sample templates",
    ],
    { cwd: repositoryRoot },
  );
  const handoffTemplateCommitSha = (
    await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })
  ).stdout.trim();
  const alphaPath = await writeBlueprint(
    repositoryRoot,
    "alpha-sample",
    blueprint(
      [
        "advance",
        "get_task_context",
        "report_blocked",
        "todo_list",
        "todo_check",
        "todo_add",
        "todo_edit",
        "todo_reorder",
      ],
      "Accept the prepared sample",
      handoffTemplateCommitSha,
    ),
  );
  const betaPath = await writeBlueprint(
    repositoryRoot,
    "beta-sample",
    blueprint(
      ["get_task_context", "report_blocked"],
      "Accept the sample",
      handoffTemplateCommitSha,
    ),
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
      finalize: effect("finalize"),
      merge: effect("merge"),
      prepare: effect("prepare"),
      "prepare-worktree": effect("prepare-worktree"),
      "review-snapshot": effect("review-snapshot"),
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
      correlationTokens: {},
      handoffs: [],
      todoState: null,
    },
  });
  await lifecycle.start({
    blueprintPath: betaPath,
    instanceId: "instance-beta",
    state: {
      correlationTokens: {},
      handoffs: [],
      todoState: null,
    },
  });
  const bootstrap = async (
    instanceId: string,
    sessionKey: string,
    token: string,
    taskContract: Record<string, string | number>,
    stage = "assess",
  ) => {
    const handoffTemplates = new GitHandoffTemplateStore(repositoryRoot);
    return bootstrapStageSession(
      {
        handoff: {
          skillPointer: "skills/sample.md",
          stage: {
            kind: "standard",
            name: stage,
            priorStageOutputs: [],
          },
          taskContract,
        },
        instanceId,
        interactionMode: "default",
        modelSelection: { instanceId: "codex", model: "default" },
        projectId: "sample-project",
        providerContext: {
          cliVersion: "1.0.0",
          driver: "codex",
          lifecycle: "independent",
          providerInstanceId: "codex",
        },
        runtimeMode: "default",
        sessionKey,
        task: taskContract,
        taskId: Number(taskContract["id"]),
        title: "Sample session",
        worktree: {
          baseRef: "main",
          branch: "sample/session",
          repositoryName: "sample-repository",
          repositoryRoot,
          worktreeName: "sample-session",
        },
      },
      {
        activationEvents: persistence,
        ensureWorktree: async ({ branch }) => ({
          branch,
          created: false,
          path: repositoryRoot,
        }),
        mintCorrelationToken: () => token,
        persistence,
        templateAuthority: {
          readHandoffTemplate: (reference) => handoffTemplates.read(reference),
          repositoryRoot,
        },
        workflowMcpEndpoint,
        t3: {
          registerWorkflowMcpProviderSession,
          applyHarnessToolTimeout: async () => undefined,
          dispatch: async () => ({ sequence: 1 }),
        },
      },
    );
  };
  await bootstrap("instance-alpha", "stage-alpha", alphaToken, {
    id: 11,
    title: "Prepare a sample",
  });
  await bootstrap("instance-beta", "stage-beta", betaToken, {
    id: 12,
    title: "Assess a sample",
  });

  const handler = createWorkflowMcpHttpHandler({
    board: {
      createRecord: async () => {
        throw new Error("Board record creation is not used by this fixture");
      },
      readTask: async () => {
        throw new Error("Board reads are not used by this fixture");
      },
    },
    lifecycle,
    persistence,
    subagentCoordinator: {} as SubagentCoordinator,
  });
  const url = await listen(handler);
  return {
    accepted,
    alphaToken,
    betaToken,
    bootstrap,
    handler,
    handoffTemplateCommitSha,
    lifecycle,
    persistence,
    repositoryRoot,
    url,
  };
};

const installDeliveryReviewFixture = async (
  repositoryRoot: string,
): Promise<string> => {
  const blueprintPath = await writeDeliveryBlueprintFixture(repositoryRoot);
  await copyFile(
    join(
      cwd(),
      "src/test-fixtures/standard-delivery/handoff-templates/standard.md",
    ),
    join(repositoryRoot, "handoff-templates/standard.md"),
  );
  await copyFile(
    join(
      cwd(),
      "src/test-fixtures/standard-delivery/todo-templates/standard-delivery-review.json",
    ),
    join(repositoryRoot, "todo-templates/standard-delivery-review.json"),
  );
  await execFileAsync(
    "git",
    [
      "add",
      "handoff-templates/standard.md",
      "todo-templates/standard-delivery-review.json",
    ],
    { cwd: repositoryRoot },
  );
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Sample User",
      "-c",
      "user.email=sample@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "add delivery review templates",
    ],
    { cwd: repositoryRoot },
  );
  const commitSha = (
    await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })
  ).stdout.trim();
  const absoluteBlueprintPath = join(repositoryRoot, blueprintPath);
  const value = JSON.parse(
    await readFile(absoluteBlueprintPath, "utf8"),
  ) as LifecycleBlueprint;
  for (const node of value.nodes) {
    if (node["handoff-template"] !== undefined) {
      node["handoff-template"].commitSha = commitSha;
    }
  }
  await writeFile(absoluteBlueprintPath, `${JSON.stringify(value, null, 2)}\n`);
  return blueprintPath;
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
  it.each([
    ["missing", undefined],
    ["unknown", "Bearer token-unknown"],
  ])("rejects a %s correlation token", async (_kind, authorization) => {
    const fixture = await makeFixture();
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    };
    if (authorization !== undefined) headers["authorization"] = authorization;

    const response = await globalThis.fetch(fixture.url, {
      body: "{}",
      headers,
      method: "POST",
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("holds the MCP 2025-11-25 ceiling without task capabilities", async () => {
    const fixture = await makeFixture();
    const response = await globalThis.fetch(fixture.url, {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "sample-client", version: "1.0.0" },
          protocolVersion: "2099-12-31",
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
    const body = (await response.json()) as {
      result?: {
        capabilities?: Record<string, unknown>;
        protocolVersion?: string;
      };
    };
    expect(body.result?.protocolVersion).toBe("2025-11-25");
    expect(body.result?.capabilities).not.toHaveProperty("tasks");
  });

  it("connects independent protocol clients without an MCP session", async () => {
    const fixture = await makeFixture();

    for (const clientName of ["sample-client-a", "sample-client-b"]) {
      const observations: HttpObservation[] = [];
      const client = await connect(
        fixture.url,
        fixture.alphaToken,
        clientName,
        observations,
      );
      await expect(client.listTools()).resolves.toMatchObject({
        tools: [
          { name: "advance" },
          { name: "get_task_context" },
          { name: "report_blocked" },
          { name: "todo_list" },
          { name: "todo_check" },
          { name: "todo_add" },
          { name: "todo_edit" },
          { name: "todo_reorder" },
        ],
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

  claudeHarnessTest(
    "discovers and calls get_task_context through Claude Code",
    async () => {
      const fixture = await makeFixture();
      const mcpConfig = JSON.stringify({
        mcpServers: {
          heddle: {
            headers: { Authorization: `Bearer ${fixture.alphaToken}` },
            type: "http",
            url: fixture.url.href,
          },
        },
      });
      const { stdout } = await execFileAsync(
        "claude",
        [
          "--no-session-persistence",
          "--output-format",
          "stream-json",
          "--verbose",
          "--mcp-config",
          mcpConfig,
          "--strict-mcp-config",
          "--allowedTools",
          "mcp__heddle__get_task_context",
          "-p",
          "Call heddle get_task_context exactly once. Return only its task title.",
        ],
        { cwd: fixture.repositoryRoot, timeout: 120_000 },
      );

      expect(stdout).toContain("get_task_context");
      expect(stdout).toContain("Prepare a sample");
    },
    130_000,
  );

  codexHarnessTest(
    "discovers and calls get_task_context through Codex",
    async () => {
      const fixture = await makeFixture();
      const { stderr, stdout } = await runHarness(
        "codex",
        [
          "exec",
          "--ephemeral",
          "--json",
          "--dangerously-bypass-approvals-and-sandbox",
          "-C",
          fixture.repositoryRoot,
          "-c",
          `mcp_servers.heddle.url=${JSON.stringify(fixture.url.href)}`,
          "-c",
          'mcp_servers.heddle.bearer_token_env_var="HEDDLE_MCP_TOKEN"',
          "Call heddle get_task_context exactly once. Return only its task title.",
        ],
        {
          cwd: fixture.repositoryRoot,
          env: { ...env, HEDDLE_MCP_TOKEN: fixture.alphaToken },
          timeout: 20_000,
        },
      );

      expect(stdout, stderr).toContain("get_task_context");
      expect(stdout).toContain("Prepare a sample");
    },
    30_000,
  );

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

  it("rejects a token handoff whose skill names differ from its static contract", async () => {
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
      stage: { skills: string[] };
    };
    handoff.stage.skills = ["different-skill"];
    fixture.persistence.updateInstance("instance-alpha", {
      ...record.state,
      handoffs: [{ ...stored, handoff: JSON.stringify(handoff) }],
    });

    await expect(
      connect(fixture.url, fixture.alphaToken, "skill-mismatched-client"),
    ).rejects.toThrow();
  });

  it("rejects a static MCP contract that names a different workflow stage", async () => {
    const fixture = await makeFixture();
    const record = fixture.persistence.getInstance("instance-alpha");
    if (record === undefined) throw new Error("alpha fixture is missing");
    const stored = record.state.handoffs[0];
    if (
      typeof stored !== "object" ||
      stored === null ||
      Array.isArray(stored) ||
      typeof stored["workflowMcp"] !== "object" ||
      stored["workflowMcp"] === null ||
      Array.isArray(stored["workflowMcp"])
    ) {
      throw new Error("alpha MCP contract fixture is invalid");
    }
    fixture.persistence.updateInstance("instance-alpha", {
      ...record.state,
      handoffs: [
        {
          ...stored,
          workflowMcp: { ...stored["workflowMcp"], stage: "inspect" },
        },
      ],
    });

    await expect(
      connect(fixture.url, fixture.alphaToken, "mismatched-client"),
    ).rejects.toThrow();
  });

  it("rejects a stored stage tool that has no registered contributor", async () => {
    const fixture = await makeFixture();
    const record = fixture.persistence.getInstance("instance-alpha");
    if (record === undefined) throw new Error("alpha fixture is missing");
    const stored = record.state.handoffs[0];
    if (
      typeof stored !== "object" ||
      stored === null ||
      Array.isArray(stored) ||
      typeof stored["workflowMcp"] !== "object" ||
      stored["workflowMcp"] === null ||
      Array.isArray(stored["workflowMcp"]) ||
      !Array.isArray(stored["workflowMcp"]["tools"])
    ) {
      throw new Error("alpha MCP contract fixture is invalid");
    }
    fixture.persistence.updateInstance("instance-alpha", {
      ...record.state,
      handoffs: [
        {
          ...stored,
          workflowMcp: {
            ...stored["workflowMcp"],
            tools: [...stored["workflowMcp"]["tools"], "missing_tool"],
          },
        },
      ],
    });

    await expect(
      fixture.handler.fetch(
        new globalThis.Request("http://mcp.invalid/", {
          body: JSON.stringify({
            id: 1,
            jsonrpc: "2.0",
            method: "tools/list",
            params: {},
          }),
          headers: {
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${fixture.alphaToken}`,
            "content-type": "application/json",
          },
          method: "POST",
        }),
      ),
    ).rejects.toThrow(
      "Workflow stage 'assess' declares MCP tool 'missing_tool' that is not registered",
    );
  });

  it("normalizes a stored pre-contract disposition as optional for exact replay", async () => {
    const fixture = await makeFixture();
    const record = fixture.persistence.getInstance("instance-alpha");
    if (record === undefined) throw new Error("alpha fixture is missing");
    const stored = record.state.handoffs[0];
    if (
      typeof stored !== "object" ||
      stored === null ||
      Array.isArray(stored) ||
      typeof stored["workflowMcp"] !== "object" ||
      stored["workflowMcp"] === null ||
      Array.isArray(stored["workflowMcp"]) ||
      !Array.isArray(stored["workflowMcp"]["dispositions"])
    ) {
      throw new Error("alpha MCP contract fixture is invalid");
    }
    const dispositions = stored["workflowMcp"]["dispositions"].map((value) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("alpha disposition fixture is invalid");
      }
      const legacy = { ...value };
      delete legacy["outputContract"];
      return legacy;
    });
    fixture.persistence.updateInstance("instance-alpha", {
      ...record.state,
      handoffs: [
        {
          ...stored,
          workflowMcp: { ...stored["workflowMcp"], dispositions },
        },
      ],
    });
    const client = await connect(
      fixture.url,
      fixture.alphaToken,
      "legacy-output-contract-client",
    );

    await expect(
      client.callTool({
        name: "advance",
        arguments: { disposition: "accept" },
      }),
    ).resolves.toMatchObject({
      structuredContent: {
        instanceId: "instance-alpha",
        status: "completed",
      },
    });
  });

  it("rejects a handoff with no static MCP contract", async () => {
    const fixture = await makeFixture();
    const record = fixture.persistence.getInstance("instance-alpha");
    if (record === undefined) throw new Error("alpha fixture is missing");
    const stored = record.state.handoffs[0];
    if (
      typeof stored !== "object" ||
      stored === null ||
      Array.isArray(stored)
    ) {
      throw new Error("alpha handoff fixture is invalid");
    }
    const withoutWorkflowMcp = { ...stored };
    delete withoutWorkflowMcp["workflowMcp"];
    fixture.persistence.updateInstance("instance-alpha", {
      ...record.state,
      handoffs: [withoutWorkflowMcp],
    });

    const response = await globalThis.fetch(fixture.url, {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "missing-contract-client", version: "1.0.0" },
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

  it("rejects bootstrap for a stage the lifecycle is not awaiting", async () => {
    const fixture = await makeFixture();

    await expect(
      fixture.bootstrap(
        "instance-alpha",
        "stage-inspect",
        "token-inspect",
        { id: 13, title: "Inspect a sample" },
        "inspect",
      ),
    ).rejects.toThrow(/does not match the awaiting lifecycle stage/);
    expect(
      fixture.persistence.getInstance("instance-alpha")?.state.handoffs,
    ).toHaveLength(1);
  });

  it("rejects bootstrap when a disposition has no description", async () => {
    const fixture = await makeFixture();
    await writeBlueprint(
      fixture.repositoryRoot,
      "alpha-sample",
      blueprint(
        ["advance", "report_blocked"],
        "",
        fixture.handoffTemplateCommitSha,
      ),
    );
    await fixture.lifecycle.rebase({
      instanceId: "instance-alpha",
      targetState: "assess",
    });

    await expect(
      fixture.bootstrap("instance-alpha", "stage-rebased", "token-rebased", {
        id: 14,
        title: "Prepare another sample",
      }),
    ).rejects.toThrow(/description for every disposition/);
    expect(
      fixture.persistence.getInstance("instance-alpha")?.state.handoffs,
    ).toHaveLength(1);
  });

  it("rejects a legacy handoff document carrying an embedded correlation token", async () => {
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
      correlationToken?: string;
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

  it("rejects a duplicate correlation token before another instance can authenticate it", async () => {
    const fixture = await makeFixture();
    const beta = fixture.persistence.getInstance("instance-beta");
    if (beta === undefined) throw new Error("beta fixture is missing");
    expect(() =>
      fixture.persistence.updateInstance("instance-beta", {
        ...beta.state,
        correlationTokens: { "stage-beta": fixture.alphaToken },
      }),
    ).toThrow(/UNIQUE constraint failed|SQLITE_CONSTRAINT/);
    expect(fixture.persistence.getInstance("instance-beta")).toEqual(beta);
    await expect(
      connect(fixture.url, fixture.alphaToken, "unique-token-client"),
    ).resolves.toBeDefined();
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
      "report_blocked",
      "todo_list",
      "todo_check",
      "todo_add",
      "todo_edit",
      "todo_reorder",
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

  it("invalidates and replaces a stage session after lifecycle rebase", async () => {
    const fixture = await makeFixture();
    const alpha = await connect(
      fixture.url,
      fixture.alphaToken,
      "pre-rebase-client",
    );
    expect(
      JSON.stringify((await alpha.listTools()).tools[0]?.inputSchema),
    ).toContain("Accept the prepared sample");
    await writeBlueprint(
      fixture.repositoryRoot,
      "alpha-sample",
      blueprint(
        ["advance", "report_blocked"],
        "Approve the rebased sample",
        fixture.handoffTemplateCommitSha,
        "approve",
      ),
    );
    await fixture.lifecycle.rebase({
      instanceId: "instance-alpha",
      targetState: "assess",
    });

    await expect(alpha.listTools()).rejects.toThrow();

    const replacementToken = "token-alpha-rebased";
    await fixture.bootstrap(
      "instance-alpha",
      "stage-alpha-rebased",
      replacementToken,
      { id: 15, title: "Approve a sample" },
    );
    const replacement = await connect(
      fixture.url,
      replacementToken,
      "rebased-client",
    );
    const tools = await replacement.listTools();

    expect(tools.tools.map(({ name }) => name)).toEqual([
      "advance",
      "report_blocked",
    ]);
    expect(JSON.stringify(tools.tools[0]?.inputSchema)).toContain(
      "Approve the rebased sample",
    );
    await expect(
      replacement.callTool({
        name: "advance",
        arguments: { disposition: "approve" },
      }),
    ).resolves.toMatchObject({
      structuredContent: { instanceId: "instance-alpha", status: "completed" },
    });
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

  it("persists the todo tool suite and carries progress into the next stage handoff", async () => {
    const fixture = await makeFixture();
    const alpha = await connect(fixture.url, fixture.alphaToken, "todo-client");

    await expect(
      alpha.callTool({
        name: "todo_check",
        arguments: { id: "orient" },
      }),
    ).resolves.toMatchObject({
      structuredContent: {
        todoList: { items: [{ checked: true, id: "orient" }] },
      },
    });
    const added = await alpha.callTool({
      name: "todo_add",
      arguments: { position: 1, text: "Check the sample label" },
    });
    const addedId = (added.structuredContent as { id: string }).id;
    await alpha.callTool({
      name: "todo_edit",
      arguments: { id: addedId, text: "Check the sample container label" },
    });
    await alpha.callTool({
      name: "todo_check",
      arguments: { id: addedId },
    });
    await alpha.callTool({
      name: "todo_reorder",
      arguments: { id: addedId, position: 0 },
    });

    const recovered = new SqlitePersistence({
      stateDirectory: join(fixture.repositoryRoot, "state"),
    });
    await expect(
      (
        await connect(fixture.url, fixture.alphaToken, "todo-retry-client")
      ).callTool({
        name: "todo_list",
        arguments: {},
      }),
    ).resolves.toMatchObject({
      structuredContent: {
        todoList: {
          items: [
            {
              checked: true,
              id: addedId,
              text: "Check the sample container label",
            },
            { checked: true, id: "orient" },
          ],
        },
      },
    });
    expect(recovered.getInstance("instance-alpha")?.state.todoState).toEqual(
      fixture.persistence.getInstance("instance-alpha")?.state.todoState,
    );
    recovered.close();

    await alpha.callTool({
      name: "advance",
      arguments: { disposition: "revise" },
    });
    const next = await fixture.bootstrap(
      "instance-alpha",
      "stage-inspect",
      "token-inspect",
      { id: 13, title: "Inspect a sample" },
      "inspect",
    );
    const handoff = JSON.parse(next.handoff) as {
      todoList: { lists: Array<{ sessionKey: string; items: unknown[] }> };
    };
    expect(handoff.todoList.lists).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionKey: "stage-alpha" }),
        expect.objectContaining({ sessionKey: "stage-inspect" }),
      ]),
    );
  });

  it("limits child todo reads and writes to its durable assigned subtree", async () => {
    const fixture = await makeFixture();
    const parent = await connect(
      fixture.url,
      fixture.alphaToken,
      "subtree-parent-client",
    );
    const inside = await parent.callTool({
      name: "todo_add",
      arguments: { parentId: "orient", text: "Inspect the nested sample" },
    });
    const outside = await parent.callTool({
      name: "todo_add",
      arguments: { text: "Inspect another sample" },
    });
    const insideId = (inside.structuredContent as { id: string }).id;
    const outsideId = (outside.structuredContent as { id: string }).id;
    claimTodoAssignment(fixture.persistence, {
      binding: resolvedSessionBindingFixture({
        sessionKey: "child-session",
        threadId: "child-thread",
      }),
      bootstrap: {
        createCommandId: "create-child",
        createdAt: new Date(0).toISOString(),
        messageId: "message-child",
        turnCommandId: "turn-child",
      },
      correlationToken: "child-token",
      depth: 1,
      instanceId: "instance-alpha",
      listSessionKey: "stage-alpha",
      model: "sample-model",
      operationId: "spawn-child",
      parentSessionKey: "stage-alpha",
      parentThreadId: "parent-thread",
      provider: "sample-provider",
      rootItemId: "orient",
      sessionKey: "child-session",
      stage: "assess",
      threadId: "child-thread",
    });
    claimTodoAssignment(fixture.persistence, {
      binding: resolvedSessionBindingFixture({
        sessionKey: "sibling-session",
        threadId: "sibling-thread",
      }),
      bootstrap: {
        createCommandId: "create-sibling",
        createdAt: new Date(0).toISOString(),
        messageId: "message-sibling",
        turnCommandId: "turn-sibling",
      },
      correlationToken: "sibling-token",
      depth: 1,
      instanceId: "instance-alpha",
      listSessionKey: "stage-alpha",
      model: "sample-model",
      operationId: "spawn-sibling",
      parentSessionKey: "stage-alpha",
      parentThreadId: "parent-thread",
      provider: "sample-provider",
      rootItemId: outsideId,
      sessionKey: "sibling-session",
      stage: "assess",
      threadId: "sibling-thread",
    });
    mutateTodoAssignment(
      fixture.persistence,
      "instance-alpha",
      "sibling-session",
      (assignment) => ({
        ...assignment,
        secretMetadata: "foreign-secret",
      }),
    );
    const record = fixture.persistence.getInstance("instance-alpha");
    if (record === undefined) throw new Error("alpha fixture is missing");
    const parentStored = record.state.handoffs[0];
    if (
      typeof parentStored !== "object" ||
      parentStored === null ||
      Array.isArray(parentStored) ||
      typeof parentStored["workflowMcp"] !== "object" ||
      parentStored["workflowMcp"] === null ||
      Array.isArray(parentStored["workflowMcp"])
    ) {
      throw new Error("alpha handoff fixture is invalid");
    }
    const handoff = assembleStageHandoff({
      correlationToken: "child-token",
      skillPointer: "skills/sample.md",
      stage: { kind: "standard", name: "assess", priorStageOutputs: [] },
      taskContract: { id: 11, title: "Prepare a sample" },
      todoList: record.state.todoState,
    });
    fixture.persistence.updateInstance("instance-alpha", {
      ...record.state,
      handoffs: [
        ...record.state.handoffs,
        {
          correlationToken: "child-token",
          handoff,
          kind: "stage-handoff",
          parentSessionKey: "stage-alpha",
          sessionKey: "child-session",
          todoAssignment: {
            listSessionKey: "stage-alpha",
            rootItemId: "orient",
          },
          workflowMcp: parentStored["workflowMcp"],
        },
      ],
    });
    const child = await connect(
      fixture.url,
      "child-token",
      "subtree-child-client",
    );

    await expect(
      parent.callTool({
        name: "todo_check",
        arguments: { id: "orient" },
      }),
    ).resolves.toMatchObject({
      content: [
        expect.objectContaining({
          text: expect.stringMatching(/assigned to child session/),
        }),
      ],
      isError: true,
    });

    await expect(
      child.callTool({ name: "todo_list", arguments: {} }),
    ).resolves.toMatchObject({
      structuredContent: {
        todoList: {
          items: expect.arrayContaining([
            expect.objectContaining({ id: "orient" }),
            expect.objectContaining({ id: insideId, parentId: "orient" }),
          ]),
        },
      },
    });
    const childList = await child.callTool({
      name: "todo_list",
      arguments: {},
    });
    const serializedChildList = JSON.stringify(childList.structuredContent);
    expect(serializedChildList).not.toContain("assignments");
    expect(serializedChildList).not.toContain("sibling-token");
    expect(serializedChildList).not.toContain("sibling-session");
    expect(serializedChildList).not.toContain("foreign-secret");
    const childMutation = await child.callTool({
      name: "todo_check",
      arguments: { checked: false, id: "orient" },
    });
    const serializedChildMutation = JSON.stringify(
      childMutation.structuredContent,
    );
    expect(serializedChildMutation).not.toContain("assignments");
    expect(serializedChildMutation).not.toContain("sibling-token");
    expect(serializedChildMutation).not.toContain("sibling-session");
    expect(serializedChildMutation).not.toContain("foreign-secret");
    expect(
      (
        childList.structuredContent as {
          todoList: { items: Array<{ id: string }> };
        }
      ).todoList.items.map(({ id }) => id),
    ).not.toContain(outsideId);
    await expect(
      child.callTool({
        name: "todo_edit",
        arguments: { id: outsideId, text: "Foreign write" },
      }),
    ).resolves.toMatchObject({
      content: [
        expect.objectContaining({
          text: expect.stringMatching(/outside the assigned subtree/),
        }),
      ],
      isError: true,
    });
    await expect(
      child.callTool({
        name: "todo_add",
        arguments: { parentId: outsideId, text: "Foreign child" },
      }),
    ).resolves.toMatchObject({
      content: [
        expect.objectContaining({
          text: expect.stringMatching(/outside the assigned subtree/),
        }),
      ],
      isError: true,
    });
    await expect(
      child.callTool({
        name: "todo_check",
        arguments: { id: insideId },
      }),
    ).resolves.toMatchObject({
      structuredContent: { todoList: expect.any(Object) },
    });
    await expect(
      child.callTool({
        name: "todo_reorder",
        arguments: { id: insideId, position: 0 },
      }),
    ).resolves.toMatchObject({
      structuredContent: { todoList: expect.any(Object) },
    });
    const reordered = fixture.persistence.getInstance("instance-alpha")?.state
      .todoState as { lists: Array<{ items: Array<{ id: string }> }> };
    expect(reordered.lists[0]?.items.map(({ id }) => id)).toEqual([
      insideId,
      "orient",
      outsideId,
    ]);

    mutateTodoAssignment(
      fixture.persistence,
      "instance-alpha",
      "child-session",
      (assignment) => ({
        ...assignment,
        status: "stopped",
        stopNotification: {
          commandId: "stop-command",
          createdAt: new Date(0).toISOString(),
          message: "Child stopped with phase completed.",
          messageId: "stop-message",
          phase: "completed",
          status: "completed",
        },
      }),
    );
    await expect(
      child.callTool({ name: "todo_check", arguments: { id: insideId } }),
    ).rejects.toThrow(/Unauthorized/);
  });

  it("atomically revokes nested writers before the top parent regains todo authority", async () => {
    const fixture = await makeFixture();
    const parent = await connect(
      fixture.url,
      fixture.alphaToken,
      "teardown-parent-client",
    );
    const nestedItem = await parent.callTool({
      name: "todo_add",
      arguments: { parentId: "orient", text: "Inspect the nested sample" },
    });
    const nestedItemId = (nestedItem.structuredContent as { id: string }).id;
    claimTodoAssignment(fixture.persistence, {
      binding: resolvedSessionBindingFixture({
        sessionKey: "child-session",
        threadId: "child-thread",
      }),
      bootstrap: {
        createCommandId: "create-child",
        createdAt: new Date(0).toISOString(),
        messageId: "message-child",
        turnCommandId: "turn-child",
      },
      correlationToken: "child-token",
      depth: 1,
      instanceId: "instance-alpha",
      listSessionKey: "stage-alpha",
      model: "sample-model",
      operationId: "spawn-child",
      parentSessionKey: "stage-alpha",
      parentThreadId: "parent-thread",
      provider: "sample-provider",
      rootItemId: "orient",
      sessionKey: "child-session",
      stage: "assess",
      threadId: "child-thread",
    });
    claimTodoAssignment(fixture.persistence, {
      binding: resolvedSessionBindingFixture({
        sessionKey: "nested-session",
        threadId: "nested-thread",
      }),
      bootstrap: {
        createCommandId: "create-nested",
        createdAt: new Date(0).toISOString(),
        messageId: "message-nested",
        turnCommandId: "turn-nested",
      },
      correlationToken: "nested-token",
      depth: 2,
      instanceId: "instance-alpha",
      listSessionKey: "stage-alpha",
      model: "sample-model",
      operationId: "spawn-nested",
      parentSessionKey: "child-session",
      parentThreadId: "child-thread",
      provider: "sample-provider",
      rootItemId: nestedItemId,
      sessionKey: "nested-session",
      stage: "assess",
      threadId: "nested-thread",
    });
    const record = fixture.persistence.getInstance("instance-alpha")!;
    const parentStored = record.state.handoffs[0] as {
      workflowMcp: Record<string, never>;
    };
    const childHandoff = (sessionKey: string, token: string) => ({
      correlationToken: token,
      handoff: assembleStageHandoff({
        correlationToken: token,
        skillPointer: "skills/sample.md",
        stage: {
          kind: "standard" as const,
          name: "assess",
          priorStageOutputs: [],
        },
        taskContract: { id: 11, title: "Prepare a sample" },
        todoList: record.state.todoState,
      }),
      kind: "stage-handoff",
      parentSessionKey:
        sessionKey === "child-session" ? "stage-alpha" : "child-session",
      sessionKey,
      todoAssignment: {
        listSessionKey: "stage-alpha",
        rootItemId: sessionKey === "child-session" ? "orient" : nestedItemId,
      },
      workflowMcp: parentStored.workflowMcp,
    });
    fixture.persistence.updateInstance("instance-alpha", {
      ...record.state,
      handoffs: [
        ...record.state.handoffs,
        childHandoff("child-session", "child-token"),
        childHandoff("nested-session", "nested-token"),
      ],
    });
    const child = await connect(
      fixture.url,
      "child-token",
      "teardown-child-client",
    );
    const nested = await connect(
      fixture.url,
      "nested-token",
      "teardown-nested-client",
    );
    await expect(
      parent.callTool({ name: "todo_check", arguments: { id: nestedItemId } }),
    ).resolves.toMatchObject({ isError: true });
    await expect(
      child.callTool({ name: "todo_check", arguments: { id: nestedItemId } }),
    ).resolves.toMatchObject({ isError: true });
    await expect(
      nested.callTool({ name: "todo_check", arguments: { id: nestedItemId } }),
    ).resolves.toMatchObject({ structuredContent: expect.any(Object) });

    stopTodoAssignmentTree(
      fixture.persistence,
      "instance-alpha",
      "child-session",
      {
        commandId: "stop-command",
        createdAt: new Date(1).toISOString(),
        message: "Child stopped with phase failed.",
        messageId: "stop-message",
        phase: "failed",
        status: "completed",
      },
    );

    await expect(
      child.callTool({ name: "todo_check", arguments: { id: nestedItemId } }),
    ).rejects.toThrow(/Unauthorized/);
    await expect(
      nested.callTool({ name: "todo_check", arguments: { id: nestedItemId } }),
    ).rejects.toThrow(/Unauthorized/);
    await expect(
      parent.callTool({ name: "todo_check", arguments: { id: nestedItemId } }),
    ).resolves.toMatchObject({ structuredContent: expect.any(Object) });
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

  it("replays advance without retaining other completed-stage authority", async () => {
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
    await expect(
      retryClient.callTool({
        name: "report_blocked",
        arguments: { message: "A late blocked report" },
      }),
    ).rejects.toThrow(/Tool report_blocked not found/);
    expect(
      (await retryClient.listTools()).tools.map(({ name }) => name),
    ).toEqual(["advance"]);
    const second = await alpha.callTool(input);

    expect(second.structuredContent).toEqual(first.structuredContent);
    expect(fixture.accepted).toHaveBeenCalledTimes(1);
    expect(
      fixture.persistence
        .replayEvents("instance-alpha")
        .some(({ type }) => type === "mcp:blocked-reported"),
    ).toBe(false);
  });

  it("rejects findings-less review rejection before lifecycle persistence", async () => {
    const fixture = await makeFixture();
    const blueprintPath = await installDeliveryReviewFixture(
      fixture.repositoryRoot,
    );
    await fixture.lifecycle.start({
      blueprintPath,
      instanceId: "instance-output-contract",
      state: { correlationTokens: {}, handoffs: [], todoState: null },
    });
    await fixture.lifecycle.resume({
      disposition: "complete",
      instanceId: "instance-output-contract",
      operationId: "implementation-complete",
    });
    const token = "token-output-contract";
    await fixture.bootstrap(
      "instance-output-contract",
      "review-output-contract",
      token,
      { id: 18, title: "Review a generic change" },
      "review",
    );
    const review = await connect(fixture.url, token, "output-contract-client");
    const beforeInvalidAdvance = fixture.persistence.getInstance(
      "instance-output-contract",
    );

    await expect(
      review.callTool({
        name: "advance",
        arguments: { disposition: "reject" },
      }),
    ).resolves.toMatchObject({
      content: [
        expect.objectContaining({
          text: expect.stringMatching(/review-findings.*output/),
        }),
      ],
      isError: true,
    });
    expect(fixture.persistence.getInstance("instance-output-contract")).toEqual(
      beforeInvalidAdvance,
    );

    await expect(
      review.callTool({
        name: "advance",
        arguments: {
          disposition: "reject",
          output: {
            findings: [
              { code: "P1", summary: "A recorded value is unchecked" },
            ],
          },
        },
      }),
    ).resolves.toMatchObject({
      structuredContent: {
        awaitingNodeIds: ["remediate"],
        instanceId: "instance-output-contract",
      },
    });
  });

  it("keeps an earlier session replay-only when the same wait stage recurs", async () => {
    const fixture = await makeFixture();
    const blueprintPath = await installDeliveryReviewFixture(
      fixture.repositoryRoot,
    );
    await fixture.lifecycle.start({
      blueprintPath,
      instanceId: "instance-recurring",
      state: { correlationTokens: {}, handoffs: [], todoState: null },
    });
    await fixture.lifecycle.resume({
      disposition: "complete",
      instanceId: "instance-recurring",
      operationId: "implementation-complete",
    });

    const firstToken = "token-review-first";
    await fixture.bootstrap(
      "instance-recurring",
      "review-first",
      firstToken,
      { id: 16, title: "Review a sample" },
      "review",
    );
    const firstReview = await connect(
      fixture.url,
      firstToken,
      "first-review-client",
    );
    const rejection = {
      name: "advance",
      arguments: {
        disposition: "reject",
        output: {
          findings: [{ code: "P1", summary: "A recorded value is unchecked" }],
        },
      },
    };
    const firstResult = await firstReview.callTool(rejection);
    await fixture.lifecycle.resume({
      disposition: "complete",
      instanceId: "instance-recurring",
      operationId: "remediation-complete",
    });

    const secondToken = "token-review-second";
    await fixture.bootstrap(
      "instance-recurring",
      "review-second",
      secondToken,
      { id: 17, title: "Review another sample" },
      "review",
    );
    const firstRetry = await connect(
      fixture.url,
      firstToken,
      "first-review-retry-client",
    );
    await expect(
      firstRetry.callTool({
        name: "report_blocked",
        arguments: { message: "A late blocked report" },
      }),
    ).rejects.toThrow(/Tool report_blocked not found/);
    expect(
      (await firstRetry.listTools()).tools.map(({ name }) => name),
    ).toEqual(["advance"]);

    const secondReview = await connect(
      fixture.url,
      secondToken,
      "second-review-client",
    );
    expect(
      (await secondReview.listTools()).tools.map(({ name }) => name),
    ).toEqual([
      "advance",
      "get_task_context",
      "report_blocked",
      "escalate",
      "create_follow_up",
      "create_finding",
      "todo_list",
      "todo_check",
      "todo_add",
      "todo_edit",
      "todo_reorder",
      "spawn",
      "liveness",
      "answer",
    ]);
    const secondTodoList = await secondReview.callTool({
      name: "todo_list",
      arguments: {},
    });
    expect(secondTodoList.structuredContent).toMatchObject({
      todoList: { sessionKey: "review-second" },
    });
    expect(
      (
        secondTodoList.structuredContent as {
          todoList: { items: unknown[] };
        }
      ).todoList.items,
    ).toEqual(
      expect.arrayContaining([
        {
          checked: false,
          id: "orient",
          text: "Orient on the review contract for Review another sample",
        },
      ]),
    );
    const replay = await firstRetry.callTool(rejection);
    expect(replay.structuredContent).toEqual(firstResult.structuredContent);
    const current = fixture.persistence.getInstance("instance-recurring");
    expect(current?.state.flowcraftContext).toMatchObject({
      awaitingNodeIds: ["review"],
    });
    expect(
      fixture.persistence
        .replayEvents("instance-recurring")
        .some(({ type }) => type === "mcp:blocked-reported"),
    ).toBe(false);
  });
});
