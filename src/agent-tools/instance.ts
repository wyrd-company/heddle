// ---
// relationships:
//   implements: agent-tools
// ---
import { randomUUID, timingSafeEqual } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { Awaiting, Data, WorkflowEngine } from "../engine/index.js";
import {
  hashToken,
  requireToolState,
  toolState,
  updateToolState,
  type ToolState,
  type TurnEndPolicy,
} from "./state.js";

export interface ToolOperations {
  status?: (input: {
    runId: string;
    nodeId: string;
    threadId: string;
    note: string;
  }) => Promise<void>;
}
const objectSchema = (
  properties: Record<string, object>,
  required: string[],
): Tool["inputSchema"] => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const questionSchema = objectSchema(
  {
    id: { type: "string", minLength: 1 },
    header: { type: "string" },
    text: { type: "string", minLength: 1 },
    options: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          description: { type: "string" },
        },
        required: ["label"],
        additionalProperties: false,
      },
    },
    "multi-select": { type: "boolean" },
  },
  ["id", "header", "text", "options", "multi-select"],
);
export class ToolInstance {
  readonly state: ToolState;
  constructor(
    readonly awaiting: Awaiting,
    private readonly engine: WorkflowEngine,
    private readonly operations: ToolOperations,
  ) {
    this.state = requireToolState(awaiting);
  }
  current(): Awaiting | undefined {
    const run = this.engine.store.get(this.awaiting.runId);
    if (run.status === "completed" || run.status === "failed") return undefined;
    return this.engine.store
      .awaiting(run.id)
      .find(
        (item) =>
          item.nodeId === this.awaiting.nodeId &&
          item.visit === this.awaiting.visit &&
          toolState(item)?.path === this.state.path &&
          !toolState(item)?.revoked,
      );
  }
  authorized(token: string): boolean {
    return (
      !!this.current() &&
      timingSafeEqual(
        Buffer.from(hashToken(token), "hex"),
        Buffer.from(this.state.tokenHash, "hex"),
      )
    );
  }
  policy(): { policy: TurnEndPolicy; requirement: string } {
    const item = this.current();
    if (!item) throw new Error("Pass is no longer awaiting");
    return {
      policy: requireToolState(item).policy,
      requirement:
        "Call the handoff tool for this stage before ending the turn.",
    };
  }
  setPolicy(policy: TurnEndPolicy, actor: string): void {
    if (!["allow", "require-handoff"].includes(policy))
      throw new Error("Unknown turn-end policy");
    const item = this.current();
    if (!item) throw new Error("Pass is no longer awaiting");
    this.engine.store.transaction(() => {
      updateToolState(this.engine.store, item, {
        ...requireToolState(item),
        policy,
      });
      this.event("turn-end-policy", { policy, actor });
    });
  }
  answerPolicy(proposalId: string, approved: boolean, actor: string): void {
    const item = this.current();
    if (!item) throw new Error("Pass is no longer awaiting");
    const state = requireToolState(item);
    const proposals = {
      ...(state["proposals"] as Record<string, TurnEndPolicy> | undefined),
    };
    const policy = proposals[proposalId];
    if (!policy) throw new Error("Unknown or answered policy proposal");
    Reflect.deleteProperty(proposals, proposalId);
    this.engine.store.transaction(() => {
      updateToolState(this.engine.store, item, {
        ...state,
        proposals,
        ...(approved ? { policy } : {}),
      });
      this.event("policy-answer", { proposalId, approved, actor, policy });
    });
  }
  revoke(): void {
    const item = this.current();
    if (!item) return;
    this.engine.store.transaction(() => {
      updateToolState(this.engine.store, item, {
        ...requireToolState(item),
        revoked: true,
      });
      this.event("agent-tools-revoked", {});
    });
  }
  private event(type: string, payload: Data): void {
    this.engine.store.event(this.awaiting.runId, type, {
      nodeId: this.awaiting.nodeId,
      visit: this.awaiting.visit,
      threadId: this.awaiting.details.threadId,
      ...payload,
    });
  }
  tools(): Tool[] {
    return [
      {
        name: "status",
        description: "Record progress without ending the stage.",
        inputSchema: objectSchema({ note: { type: "string", minLength: 1 } }, [
          "note",
        ]),
      },
      {
        name: "escalate",
        description: "Ask a question or request help.",
        inputSchema: questionSchema,
      },
      {
        name: "handoff",
        description: String(this.state.handoff["description"]),
        inputSchema: this.state.handoff as Tool["inputSchema"],
      },
      {
        name: "propose-policy",
        description: "Ask the operator to change the turn-end policy.",
        inputSchema: objectSchema(
          {
            policy: { enum: ["allow", "require-handoff"] },
            reason: { type: "string", minLength: 1 },
          },
          ["policy", "reason"],
        ),
      },
      {
        name: "context",
        description: "Read the task context for this stage.",
        inputSchema: objectSchema({}, []),
      },
    ];
  }
  server() {
    const server = new McpServer(
      { name: "heddle-stage", version: "0.0.0" },
      { capabilities: { tools: {} } },
    ).server;
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: this.tools(),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const tool = this.tools().find(
        (tool) => tool.name === request.params.name,
      );
      if (!tool) throw new Error("Unknown tool");
      const validate = new Ajv2020({ strict: false, allErrors: true }).compile(
        tool.inputSchema,
      );
      const args = request.params.arguments ?? {};
      if (!validate(args))
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(validate.errors) }],
        };
      if (!this.current())
        return {
          isError: true,
          content: [{ type: "text", text: "Pass is no longer awaiting" }],
        };
      const result = await this.call(tool.name, args);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    });
    return server;
  }
  private async call(name: string, args: Data): Promise<unknown> {
    const { runId, nodeId, visit, details } = this.awaiting;
    if (name === "context") return this.state.context;
    if (
      name === "handoff" ||
      (name === "escalate" && this.state.escalation === "ends-stage")
    ) {
      return this.engine.resume({
        runId,
        nodeId,
        visit,
        result: name,
        payload: args,
      });
    }
    if (name === "status") {
      this.event("status", args);
      await this.operations.status?.({
        runId,
        nodeId,
        threadId: String(details.threadId),
        note: String(args["note"]),
      });
    } else if (name === "propose-policy") {
      const proposalId = randomUUID();
      const item = this.current();
      if (!item) throw new Error("Pass is no longer awaiting");
      const state = requireToolState(item);
      this.engine.store.transaction(() => {
        updateToolState(this.engine.store, item, {
          ...state,
          proposals: {
            ...(state["proposals"] as Data),
            [proposalId]: args["policy"],
          },
        });
        this.event("question", {
          role: "operator",
          kind: "turn-end-policy",
          proposalId,
          id: proposalId,
          header: "Turn-end policy",
          text: `Change the turn-end policy to ${String(args["policy"])}: ${String(args["reason"])}`,
          options: [{ label: "Approve" }, { label: "Decline" }],
          "multi-select": false,
          ...args,
        });
      });
      return { proposalId };
    } else if (name === "escalate") {
      this.event("question", args);
      try {
        await this.engine.startRelated({
          id: JSON.stringify([runId, nodeId, visit, args["id"]]),
          parentId: runId,
          parentNodeId: nodeId,
          blueprintId: "answer-question",
          context: {
            question: args,
            threadId: details.threadId,
            runContext: this.state.context,
          },
        });
      } catch (error) {
        this.event("attention", {
          question: args,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { recorded: true };
  }
}
