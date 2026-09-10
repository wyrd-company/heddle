#!/usr/bin/env node
// ---
// relationships:
//   verifies: heddle
//   references: cursor-headless
// ---

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers";

const arguments_ = process.argv.slice(2);
if (process.env.HEDDLE_CONTROLLED_PROVIDER === "1") {
  const log = process.env.HEDDLE_CONTROLLED_PROVIDER_LOG;
  const homeSentinel = join(process.env.HOME ?? "", "credential-sentinel");
  let homeSentinelBefore = null;
  try {
    homeSentinelBefore = readFileSync(homeSentinel, "utf8");
    appendFileSync(homeSentinel, "controlled-provider-touch\n");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (log)
    appendFileSync(
      log,
      `${JSON.stringify({ arguments: arguments_, home: process.env.HOME, homeSentinelBefore })}\n`,
    );
}
if (arguments_[0] === "--version") {
  process.stdout.write("1.0.13\n");
  process.exit(0);
}
if (arguments_[0] === "about") {
  const probeDelay = Number.parseInt(
    process.env.HEDDLE_CONTROLLED_PROVIDER_PROBE_DELAY_MS ?? "0",
    10,
  );
  if (Number.isFinite(probeDelay) && probeDelay > 0)
    await new Promise((resolve) => setTimeout(resolve, probeDelay));
  process.stdout.write(
    `${JSON.stringify({ cliVersion: "2026.08.11-e8db854", model: "Auto" })}\n`,
  );
  process.exit(0);
}

const expectedApiKey = process.env.HEDDLE_CURSOR_EXPECTED_API_KEY;
if (
  process.env.HEDDLE_CONTROLLED_PROVIDER !== "1" &&
  (!expectedApiKey || process.env.CURSOR_API_KEY !== expectedApiKey)
)
  process.exit(77);

const requestLog = process.env.HEDDLE_CURSOR_TEST_REQUEST_LOG;
const promptDelayMs = Number.parseInt(
  process.env.HEDDLE_CURSOR_TEST_PROMPT_DELAY_MS ?? "0",
  10,
);
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

const completePrompt = (request) => {
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
};

const pendingPrompts = new Map();

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
    const pendingPrompt = pendingPrompts.get(request.id);
    if (pendingPrompt) {
      log({ userInputResponse: request.result });
      pendingPrompts.delete(request.id);
      completePrompt(pendingPrompt);
      newline = input.indexOf("\n");
      continue;
    }
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
      case "session/prompt": {
        const promptText = JSON.stringify(request.params.prompt ?? "");
        if (promptText.includes("REQUEST_USER_INPUT")) {
          const requestId = "fixture-user-input-1";
          pendingPrompts.set(requestId, request);
          process.stdout.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: requestId,
              method: "cursor/ask_question",
              params: {
                toolCallId: "fixture-question-tool-call",
                title: "Question",
                questions: [
                  {
                    id: "quantity",
                    prompt: "Which quantity?",
                    options: [
                      { id: "small", label: "Small" },
                      { id: "large", label: "Large" },
                    ],
                  },
                  ...(promptText.includes("REQUEST_USER_INPUT_SELECTIONS")
                    ? [
                        {
                          id: "ingredients",
                          prompt: "Which ingredients?",
                          allowMultiple: true,
                          options: [
                            { id: "rice", label: "Rice" },
                            { id: "beans", label: "Beans" },
                          ],
                        },
                      ]
                    : []),
                ],
              },
            })}\n`,
          );
          break;
        }
        if (promptText.includes("REQUEST_APPROVAL")) {
          const requestId = "fixture-approval-1";
          pendingPrompts.set(requestId, request);
          process.stdout.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: requestId,
              method: "session/request_permission",
              params: {
                sessionId: request.params.sessionId,
                toolCall: {
                  toolCallId: "fixture-approval-tool-call",
                  title: "Allow sample action",
                },
                options: [
                  { optionId: "allow", name: "Allow", kind: "allow_once" },
                  { optionId: "reject", name: "Reject", kind: "reject_once" },
                ],
              },
            })}\n`,
          );
          break;
        }
        if (Number.isFinite(promptDelayMs) && promptDelayMs > 0)
          setTimeout(() => completePrompt(request), promptDelayMs);
        else completePrompt(request);
        break;
      }
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
