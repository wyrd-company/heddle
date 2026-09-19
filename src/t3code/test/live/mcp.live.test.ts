// ---
// relationships:
//   validates: design
// ---
/**
 * Fork-specific external MCP registration against a real T3 Code server.
 * T3_LIVE_AGENT=1 also starts a provider turn and spends provider credit.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket as WsWebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { T3Client } from "../../src/client.js";
import type { WebSocketConstructor } from "../../src/internal/websocket.js";
import { threadId, type ProjectId, type ThreadId } from "../../src/schemas/common.js";
import { startMcpFixture, type McpFixture } from "../support/mcp-fixture.js";

const baseUrl = process.env["T3_LIVE_URL"];
const token = process.env["T3_LIVE_TOKEN"];
const model = process.env["T3_LIVE_MODEL"] ?? "gpt-5.6-luna";
const enabled = process.env["T3_LIVE"] === "1" && Boolean(baseUrl) && Boolean(token);
const agent = process.env["T3_LIVE_AGENT"] === "1";
const toolName = "record_probe_nonce";

describe.skipIf(!enabled)("live external MCP", () => {
  let client: T3Client;
  let fixture: McpFixture;
  let workspaceRoot: string;
  let projectId: ProjectId | undefined;
  const id: ThreadId = threadId(randomUUID());
  const nonce = randomUUID();
  const authorizationHeader = `Bearer ${randomUUID()}`;

  beforeAll(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "t3code-client-mcp-live-"));
    fixture = await startMcpFixture({ authorizationHeader, toolName });
    client = T3Client.create({
      baseUrl: baseUrl ?? "",
      accessToken: token ?? "",
      clientLabel: "t3code-client-mcp-live",
      webSocket: WsWebSocket as unknown as WebSocketConstructor,
    });
    const project = await client.projects.ensure({ workspaceRoot, title: "MCP live sample" });
    projectId = project.id;
    await client.threads.ensure({
      threadId: id,
      projectId: project.id,
      title: "MCP live sample thread",
      modelSelection: { instanceId: "codex" as never, model },
      runtimeMode: "auto",
    });
  });

  afterAll(async () => {
    try {
      await client.mcp.clear({ threadId: id, name: "probe" });
      await client.threads.delete(id);
      if (projectId !== undefined) await client.projects.delete(projectId, { force: true });
    } finally {
      await client.close();
      await fixture.stop();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("registers and clears an external MCP server idempotently", async () => {
    await client.mcp.register({
      threadId: id,
      name: "probe",
      endpoint: fixture.endpoint,
      authorizationHeader,
    });
    await client.mcp.clear({ threadId: id, name: "probe" });
    await client.mcp.clear({ threadId: id, name: "probe" });
  });

  it.skipIf(!agent)(
    "lets a real agent call the registered tool",
    async () => {
      await client.mcp.register({
        threadId: id,
        name: "probe",
        endpoint: fixture.endpoint,
        authorizationHeader,
      });
      const startedAt = Date.now();
      const turn = await client.threads.startTurn({
        threadId: id,
        text: `Call the ${toolName} tool with nonce "${nonce}". Call it exactly once, then reply with the word done.`,
      });
      const outcome = await turn.completion;
      const elapsedMs = Date.now() - startedAt;

      console.info(`MCP turn settled in ${elapsedMs} ms`, fixture.calls);
      expect(outcome.state).toBe("completed");
      expect(fixture.calls).toHaveLength(1);
      expect(fixture.calls[0]).toMatchObject({
        name: toolName,
        arguments: { nonce },
        authorization: authorizationHeader,
      });
      expect(fixture.calls[0]?.receivedAt).toBeGreaterThanOrEqual(startedAt);
    },
    180_000,
  );
});
