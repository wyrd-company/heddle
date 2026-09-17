// ---
// relationships:
//   implements: agent-tools
// ---
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { WorkflowEngine } from "../engine/index.js";
import { ToolInstance, type ToolOperations } from "./instance.js";
import { toolState, type TurnEndPolicy } from "./state.js";

export class GeneratedToolService {
  private readonly instances = new Map<string, ToolInstance>();
  constructor(
    private readonly engine: WorkflowEngine,
    private readonly operations: ToolOperations = {},
    private readonly rejected: (path: string) => void = (path) => {
      console.warn(`Rejected agent-tools request: ${path}`);
    },
  ) {
    this.recover();
  }
  recover(): void {
    this.instances.clear();
    for (const item of this.engine.store.awaiting()) {
      if (item.details.kind !== "pass" || !item.details.threadId) continue;
      const state = toolState(item);
      if (state && !state.revoked)
        this.instances.set(
          state.path,
          new ToolInstance(item, this.engine, this.operations),
        );
    }
  }
  setPolicy(path: string, policy: TurnEndPolicy, actor: string): void {
    this.instance(path).setPolicy(policy, actor);
  }
  answerPolicy(
    path: string,
    proposalId: string,
    approved: boolean,
    actor: string,
  ): void {
    this.instance(path).answerPolicy(proposalId, approved, actor);
  }
  async observeTurnEnd(
    path: string,
    payload: Record<string, unknown> = {},
  ): Promise<"applied" | "late-wakeup" | "held"> {
    const instance = this.instance(path);
    const item = instance.current();
    if (!item) return "late-wakeup";
    const policy = instance.policy();
    return this.engine.resume({
      runId: item.runId,
      nodeId: item.nodeId,
      visit: item.visit,
      result: "turnEnded",
      payload: {
        ...payload,
        policy: policy.policy,
        reminder:
          policy.policy === "require-handoff" ? policy.requirement : null,
      },
    });
  }
  revoke(path: string): void {
    this.instance(path).revoke();
    this.instances.delete(path);
  }
  private instance(path: string): ToolInstance {
    const instance = this.instances.get(path);
    if (!instance) throw new Error("Unknown generated instance");
    return instance;
  }
  async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const path = pathname.endsWith("/policy")
      ? pathname.slice(0, -7)
      : pathname;
    const instance = this.instances.get(path);
    const bearer = request.headers.authorization;
    if (
      !instance ||
      !bearer?.startsWith("Bearer ") ||
      !instance.authorized(bearer.slice(7))
    ) {
      this.rejected(path);
      response.writeHead(401, { "content-type": "application/json" }).end(
        JSON.stringify({
          error: "Generated instance unavailable or credential rejected",
        }),
      );
      return;
    }
    if (pathname.endsWith("/policy")) {
      if (request.method !== "GET") {
        response.writeHead(405).end();
        return;
      }
      response
        .writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        })
        .end(JSON.stringify(instance.policy()));
      return;
    }
    const server = instance.server();
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport as Transport);
      await transport.handleRequest(request, response);
    } finally {
      await server.close();
    }
  }
}
