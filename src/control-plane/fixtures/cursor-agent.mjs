#!/usr/bin/env node
// ---
// relationships:
//   verifies: heddle
//   references: cursor-headless
// ---

import { appendFileSync } from "node:fs";
import process from "node:process";

const arguments_ = process.argv.slice(2);
if (arguments_[0] === "about") {
  process.stdout.write(
    `${JSON.stringify({ cliVersion: "2026.08.11-e8db854", model: "Auto" })}\n`,
  );
  process.exit(0);
}

const expectedApiKey = process.env.HEDDLE_CURSOR_EXPECTED_API_KEY;
if (!expectedApiKey || process.env.CURSOR_API_KEY !== expectedApiKey)
  process.exit(77);

const requestLog = process.env.HEDDLE_CURSOR_TEST_REQUEST_LOG;
const log = (entry) => {
  if (requestLog) appendFileSync(requestLog, `${JSON.stringify(entry)}\n`);
};
log({ apiKeyInjected: true, arguments: arguments_ });

const modes = {
  currentModeId: "agent",
  availableModes: [
    { id: "agent", name: "Agent" },
    { id: "plan", name: "Plan" },
    { id: "ask", name: "Ask" },
  ],
};
const models = {
  currentModelId: "default",
  availableModels: [{ modelId: "default", name: "Auto" }],
};
const respond = (id, result) => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
};

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  let newline = input.indexOf("\n");
  while (newline >= 0) {
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    if (!line.trim()) {
      newline = input.indexOf("\n");
      continue;
    }
    const request = JSON.parse(line);
    log({ id: request.id, method: request.method });
    switch (request.method) {
      case "initialize":
        respond(request.id, {
          protocolVersion: 1,
          agentCapabilities: { loadSession: false },
        });
        break;
      case "session/new":
        respond(request.id, {
          sessionId: "fixture-session",
          modes,
          models,
          configOptions: [],
        });
        break;
      case "session/set_model":
      case "session/set_mode":
        respond(request.id, {});
        break;
      case "session/set_config_option":
        respond(request.id, { configOptions: [] });
        break;
      case "session/prompt":
        process.stdout.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: request.params.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "done" },
              },
            },
          })}\n`,
        );
        respond(request.id, { stopReason: "end_turn" });
        break;
      case "cursor/list_available_models":
        respond(request.id, {
          models: [{ value: "default", name: "Auto", configOptions: [] }],
        });
        break;
      case "session/cancel":
        if (request.id !== undefined) respond(request.id, {});
        break;
      case "authenticate":
        respond(request.id, { fixtureReceivedForbiddenAuthenticate: true });
        break;
      default:
        if (request.id !== undefined)
          process.stdout.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              error: { code: -32601, message: "Method not found" },
            })}\n`,
          );
    }
    newline = input.indexOf("\n");
  }
});
