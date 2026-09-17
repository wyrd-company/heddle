// ---
// relationships:
//   verifies: agent-tools
// ---
import { createServer } from "node:http";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
const root = process.argv[2];
if (!root) throw new Error("Fixture root required");
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const input = JSON.parse(body);
  if (
    request.url !== "/hook/stop" ||
    request.method !== "POST" ||
    typeof input.session_id !== "string"
  ) {
    response.writeHead(400).end();
    return;
  }
  await appendFile(
    join(root, "hook-events.jsonl"),
    JSON.stringify({ at: Date.now(), session_id: input.session_id }) + "\n",
  );
  response.writeHead(200, { "content-type": "application/json" }).end("{}");
});
server.listen(join(root, "hooks.sock"), () =>
  console.log("fixture hook receiver ready"),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => server.close());
