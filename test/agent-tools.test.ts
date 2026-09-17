// ---
// relationships:
//   verifies: agent-tools
// ---
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { parse } from "yaml";
import type { WorkflowBlueprint } from "flowcraft";
import { afterEach, expect, it } from "vitest";
import {
  WorkflowEngine,
  RunStore,
  type Data,
  type EngineNode,
} from "../src/engine/index.js";
import {
  GeneratedToolService,
  prepareAgentTools,
  type ToolBinding,
} from "../src/agent-tools/index.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
export const handoff = parse(
  "description: Submit the inspection report.\ntype: object\nproperties:\n  condition:\n    type: string\n    enum: [sound, damaged]\nrequired: [condition]\nadditionalProperties: false\n",
) as Data;
async function fixture(
  options: {
    escalation?: "answer-in-place" | "ends-stage";
    answer?: boolean;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "heddle-tools-"));
  cleanups.push(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const store = new RunStore(join(directory, "runs.sqlite"));
  cleanups.push(() => {
    store.close();
  });
  const bindings: ToolBinding[] = [];
  const pass: EngineNode = async (context) => {
    const prepared = prepareAgentTools({
      threadId: `thread-${context.run.id}`,
      handoff,
      context: { item: "book", priorHandoffs: [], metadata: { shelf: 4 } },
      ...(options.escalation ? { escalation: options.escalation } : {}),
    });
    bindings.push(prepared.binding);
    await context.await(prepared.details);
  };
  const blueprint: WorkflowBlueprint = {
    id: "inspection",
    nodes: [
      { id: "inspect", uses: "pass" },
      { id: "done", uses: "done" },
    ],
    edges: [{ source: "inspect", target: "done" }],
  };
  const helper: WorkflowBlueprint = {
    id: "answer-question",
    nodes: [{ id: "answer", uses: "answer" }],
    edges: [],
  };
  const engine = new WorkflowEngine(store, {
    resolveBlueprint: (_commit, id) => {
      if (id === helper.id) {
        if (options.answer) return Promise.resolve(helper);
        throw new Error("Blueprint does not exist");
      }
      return Promise.resolve(blueprint);
    },
    nodes: {
      pass,
      done: () => Promise.resolve({ finished: true }),
      answer: () => Promise.resolve({ answer: "Check the cover." }),
    },
  });
  await engine.start({
    id: "run-a",
    blueprintId: blueprint.id,
    commit: "snapshot-a",
  });
  await engine.start({
    id: "run-b",
    blueprintId: blueprint.id,
    commit: "snapshot-b",
  });
  const rejected: string[] = [];
  const service = new GeneratedToolService(engine, {}, (path) =>
    rejected.push(path),
  );
  const server = createServer((req, res) => {
    void service.handle(req, res).catch((error: unknown) => {
      res.writeHead(500).end(String(error));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      }),
  );
  const origin = `http://127.0.0.1:${String((server.address() as { port: number }).port)}`;
  const rpc = async (
    binding: ToolBinding,
    method: string,
    params: Data = {},
  ) => {
    const response = await fetch(origin + binding.path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${binding.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return {
      status: response.status,
      body: (await response.json()) as {
        result: {
          isError?: boolean;
          content: { text: string }[];
          tools: { name: string; description: string; inputSchema: Data }[];
        };
      },
    };
  };
  const call = (
    name: string,
    args: Data = {},
    binding = required(bindings[0]),
  ) => rpc(binding, "tools/call", { name, arguments: args });
  return {
    store,
    engine,
    service,
    bindings,
    rpc,
    call,
    rejected,
    origin,
    directory,
  };
}
it("lists five generated tools with the exact handoff schema and description", async () => {
  const f = await fixture();
  const list = await f.rpc(required(f.bindings[0]), "tools/list");
  expect(list.status).toBe(200);
  expect(list.body.result.tools.map((t) => t.name)).toEqual([
    "status",
    "escalate",
    "handoff",
    "propose-policy",
    "context",
  ]);
  expect(list.body.result.tools.find((t) => t.name === "handoff")).toEqual({
    name: "handoff",
    description: handoff["description"],
    inputSchema: handoff,
  });
  expect(JSON.stringify(f.store.awaiting())).not.toContain(
    required(f.bindings[0]).token,
  );
});
it("invalid handoff returns schema errors without resume; valid handoff resumes the real engine with payload", async () => {
  const f = await fixture();
  const invalid = await f.call("handoff", { condition: "unknown" });
  expect(invalid.body.result.isError).toBe(true);
  expect(required(invalid.body.result.content[0]).text).toContain("enum");
  expect(f.store.get("run-a").status).toBe("awaiting");
  const result = await f.call("handoff", { condition: "sound" });
  expect(result.body.result.isError).toBeUndefined();
  expect(f.store.get("run-a").status).toBe("completed");
  expect(f.store.events("run-a").filter((e) => e.type === "resume")).toEqual([
    matches({
      payload: matches({
        result: "handoff",
        payload: { condition: "sound" },
      }),
    }),
  ]);
});
it("isolates populated instances and rejects revoked, terminal, and unknown paths with a log", async () => {
  const f = await fixture();
  expect(
    (
      await f.rpc(
        { ...required(f.bindings[1]), token: required(f.bindings[0]).token },
        "tools/list",
      )
    ).status,
  ).toBe(401);
  expect((await f.rpc(required(f.bindings[1]), "tools/list")).status).toBe(200);
  f.service.revoke(required(f.bindings[0]).path);
  expect((await f.rpc(required(f.bindings[0]), "tools/list")).status).toBe(401);
  f.service.recover();
  expect((await f.rpc(required(f.bindings[0]), "tools/list")).status).toBe(401);
  await f.call("handoff", { condition: "sound" }, f.bindings[1]);
  expect((await f.rpc(required(f.bindings[1]), "tools/list")).status).toBe(401);
  expect(
    (
      await f.rpc(
        { ...required(f.bindings[0]), path: "/agent-tools/missing" },
        "tools/list",
      )
    ).status,
  ).toBe(401);
  expect(f.rejected).toHaveLength(5);
});
const question = {
  id: "cover",
  header: "Condition",
  text: "Should I check the cover?",
  options: [{ label: "Yes" }],
  "multi-select": false,
};
it("records answer-in-place escalation and attention without waking the pass", async () => {
  const f = await fixture();
  await f.call("escalate", question);
  expect(f.store.get("run-a").status).toBe("awaiting");
  expect(f.store.events("run-a").map((e) => e.type)).toEqual(
    expect.arrayContaining(["question", "attention"]) as unknown,
  );
});
it("starts the supplied answer-question run at the pinned commit without waking the pass", async () => {
  const f = await fixture({ answer: true });
  await f.call("escalate", question);
  expect(
    f.store.list().find((r) => r.blueprintId === "answer-question"),
  ).toMatchObject({
    status: "completed",
    commit: "snapshot-a",
    parentId: "run-a",
    parentNodeId: "inspect",
    rootId: "run-a",
    initialContext: { question },
  });
  expect(f.store.get("run-a").status).toBe("awaiting");
});
it("ends-stage escalation resumes with escalate", async () => {
  const f = await fixture({ escalation: "ends-stage" });
  await f.call("escalate", question);
  expect(f.store.get("run-a").status).toBe("completed");
  expect(f.store.events("run-a")).toContainEqual(
    matches({
      type: "resume",
      payload: matches({
        result: "escalate",
        payload: question,
      }),
    }),
  );
});
it("status and context do not resume; policy proposal waits for the operator", async () => {
  const f = await fixture();
  await f.call("status", { note: "Cover inspected." });
  expect(
    required((await f.call("context")).body.result.content[0]).text,
  ).toContain("book");
  const policy = async () => {
    const r = await fetch(f.origin + required(f.bindings[0]).path + "/policy", {
      headers: { authorization: `Bearer ${required(f.bindings[0]).token}` },
    });
    return r.json();
  };
  await f.call("propose-policy", {
    policy: "allow",
    reason: "Waiting for an answer.",
  });
  expect(await policy()).toMatchObject({ policy: "require-handoff" });
  expect(f.store.events("run-a")).toContainEqual(
    matches({
      type: "question",
      payload: matches({ role: "operator", policy: "allow" }),
    }),
  );
  f.service.setPolicy(required(f.bindings[0]).path, "allow", "operator");
  expect(await policy()).toMatchObject({ policy: "allow" });
  f.service.recover();
  expect(await policy()).toMatchObject({ policy: "allow" });
  expect(f.store.get("run-a").status).toBe("awaiting");
  expect(
    readFileSync(join(f.directory, "runs.sqlite")).includes(
      Buffer.from(required(f.bindings[0]).token),
    ),
  ).toBe(false);
});
it("observation resumes turnEnded with a missing-handoff reminder", async () => {
  const f = await fixture();
  await f.service.observeTurnEnd(required(f.bindings[0]).path, {
    turnId: "turn-1",
  });
  expect(f.store.events("run-a")).toContainEqual(
    matches({
      type: "resume",
      payload: matches({
        result: "turnEnded",
        payload: matches({
          policy: "require-handoff",
          reminder: containing("handoff"),
          turnId: "turn-1",
        }),
      }),
    }),
  );
});
it("policy answers are durable, apply only on approval, and cannot be replayed", async () => {
  const f = await fixture();
  const proposal = await f.call("propose-policy", {
    policy: "allow",
    reason: "Waiting for the reader.",
  });
  const { proposalId } = JSON.parse(
    required(proposal.body.result.content[0]).text,
  ) as {
    proposalId: string;
  };
  f.service.recover();
  f.service.answerPolicy(
    required(f.bindings[0]).path,
    proposalId,
    false,
    "operator",
  );
  expect(
    required(f.store.awaiting("run-a")[0]).details["agentTools"],
  ).toMatchObject({ policy: "require-handoff" });
  expect(() => {
    f.service.answerPolicy(
      required(f.bindings[0]).path,
      proposalId,
      true,
      "operator",
    );
  }).toThrow("answered");
  const second = await f.call("propose-policy", {
    policy: "allow",
    reason: "Waiting for the reader.",
  });
  const next = JSON.parse(required(second.body.result.content[0]).text) as {
    proposalId: string;
  };
  f.service.answerPolicy(
    required(f.bindings[0]).path,
    next.proposalId,
    true,
    "operator",
  );
  expect(
    required(f.store.awaiting("run-a")[0]).details["agentTools"],
  ).toMatchObject({
    policy: "allow",
    proposals: {},
  });
});
it("observation follows the blueprint continuation count and carries a reminder on every required handoff", async () => {
  const directory = mkdtempSync(join(tmpdir(), "heddle-continuation-"));
  cleanups.push(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const store = new RunStore(join(directory, "runs.sqlite"));
  cleanups.push(() => {
    store.close();
  });
  const bindings: ToolBinding[] = [];
  const blueprint: WorkflowBlueprint = {
    id: "inspection",
    metadata: { cycleEntryPoints: ["inspect"] },
    nodes: [
      { id: "inspect", uses: "pass" },
      { id: "count", uses: "count" },
      { id: "finish", uses: "done" },
    ],
    edges: [
      {
        source: "inspect",
        target: "count",
        condition: "result.output.turnEnded",
      },
      { source: "count", target: "inspect", condition: "attempts < 2" },
      { source: "count", target: "finish", condition: "attempts >= 2" },
    ],
  };
  const engine = new WorkflowEngine(store, {
    resolveBlueprint: () => Promise.resolve(blueprint),
    nodes: {
      pass: async (context) => {
        const prepared = prepareAgentTools({
          threadId: `thread-${String(context.visit)}`,
          handoff,
          context: { item: "book" },
        });
        bindings.push(prepared.binding);
        await context.await(prepared.details);
      },
      count: ({ context }) => {
        context["attempts"] = Number(context["attempts"] ?? 0) + 1;
        return Promise.resolve();
      },
      done: () => Promise.resolve({ finished: true }),
    },
  });
  await engine.start({
    id: "inspection-a",
    blueprintId: blueprint.id,
    commit: "snapshot-a",
  });
  const service = new GeneratedToolService(engine);
  for (let index = 0; index < 2; index++) {
    await service.observeTurnEnd(required(bindings[index]).path);
    service.recover();
  }
  expect(bindings).toHaveLength(2);
  expect(store.get("inspection-a")).toMatchObject({
    status: "completed",
    context: { attempts: 2 },
  });
  const resumed = store
    .events("inspection-a")
    .filter((event) => event.type === "resume");
  expect(resumed).toHaveLength(2);
  for (const event of resumed)
    expect(event.payload).toMatchObject({
      result: "turnEnded",
      payload: { reminder: containing("handoff") },
    });
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}

function matches(value: Record<string, unknown>): unknown {
  return expect.objectContaining(value);
}
function containing(value: string): unknown {
  return expect.stringContaining(value);
}

it("preparation freezes schema and context before caller artifacts change", () => {
  const schema = structuredClone(handoff);
  const context = { item: "book" };
  const prepared = prepareAgentTools({
    threadId: "thread-fixture",
    handoff: schema,
    context,
  });
  expect((prepared.details["agentTools"] as Data)["tokenHash"]).toMatch(
    /^[a-f0-9]{64}$/,
  );
  expect(JSON.stringify(prepared.details)).not.toContain(
    prepared.binding.token,
  );
  schema["description"] = "Altered";
  context.item = "magazine";
  expect(prepared.details["agentTools"]).toMatchObject({
    handoff: { description: "Submit the inspection report." },
    context: { item: "book" },
  });
});
it("operator policy updates both engine checkpoint carriers", async () => {
  const f = await fixture();
  f.service.setPolicy(required(f.bindings[0]).path, "allow", "operator");
  const run = f.store.get("run-a");
  for (const context of [run.context, run.checkpoint.context])
    expect(context["_awaitingDetails"]).toMatchObject({
      inspect: { agentTools: { policy: "allow" } },
    });
});

it.each([
  { type: "object", properties: {} },
  { type: "array", description: "Submit the report." },
  { type: "object", description: " ", properties: {} },
  {
    type: "object",
    description: "Submit the report.",
    properties: { value: { type: "not-a-type" } },
  },
])("rejects invalid generated handoff definitions %#", (schema) => {
  expect(() =>
    prepareAgentTools({
      threadId: "thread-fixture",
      handoff: schema,
      context: {},
    }),
  ).toThrow();
});
