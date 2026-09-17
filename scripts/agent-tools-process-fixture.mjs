// ---
// relationships:
//   verifies: agent-tools
// ---
import { createServer } from "node:http";
import {
  WorkflowEngine,
  RunStore,
  GeneratedToolService,
  prepareAgentTools,
} from "../dist/index.js";
const store = new RunStore(process.argv[2]);
const blueprint = {
  id: "inspection",
  nodes: [{ id: "inspect", uses: "pass" }],
  edges: [],
};
const bindings = [];
const engine = new WorkflowEngine(store, {
  resolveBlueprint: async () => blueprint,
  nodes: {
    pass: async (context) => {
      const prepared = prepareAgentTools({
        threadId: "thread-" + context.run.id,
        handoff: {
          type: "object",
          description: "Submit the inspection.",
          properties: { condition: { type: "string" } },
          required: ["condition"],
        },
        context: { item: context.run.id },
      });
      bindings.push(prepared.binding);
      await context.await(prepared.details);
    },
  },
});
if (store.list().length === 0) {
  for (const id of ["book-a", "book-b"])
    await engine.start({
      id,
      blueprintId: "inspection",
      commit: "snapshot-fixture",
    });
}
await engine.recover();
const service = new GeneratedToolService(engine, {}, () => {});
const server = createServer((req, res) => {
  void service.handle(req, res).catch((error) => {
    res.writeHead(500).end(String(error));
  });
});
server.listen(Number(process.argv[3] ?? 0), "127.0.0.1", () =>
  process.send({ port: server.address().port, bindings }),
);
