#!/usr/bin/env node
// ACP shim for driving the cursor agent with CURSOR_API_KEY auth under T3.
//
// Why: T3's AcpSessionRuntime sends `authenticate {methodId:"cursor_login"}`
// unconditionally after `initialize`. With interactive `agent login` state that
// returns; with env-var (CURSOR_API_KEY) auth the cursor agent never answers it
// and the T3 session hangs in `starting` forever — even though `session/new`
// and everything after it work fine without authenticate under an API key.
//
// This shim spawns the real agent (`CURSOR_ACP_SHIM_TARGET`, default
// `cursor-agent`) with `acp`, passes all traffic through untouched, except
// requests whose method is `authenticate`: those are answered locally with an
// empty result and never forwarded. Point T3's cursor `binaryPath` at this
// file via a one-line wrapper script (T3 appends the `acp` arg itself).
// Secondary duty (question-path proof): the cursor backend decides per
// session whether the model gets the AskQuestion tool, and it granted it to
// no session in this spike ("not available in the current agent session tool
// definitions"). To still prove T3's cursor/ask_question -> user-input
// round-trip on the headless control surface, the shim watches forwarded
// `session/prompt` requests for the marker [SPIKE-ASK-QUESTION] and then
// emits its own `cursor/ask_question` request to T3 — byte-identical to what
// the real agent would send. T3's response (or settle-on-stop empty answers)
// is appended to SPIKE_SHIM_LOG as JSON lines.
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";

const target = process.env.CURSOR_ACP_SHIM_TARGET || "cursor-agent";
const logPath = process.env.SPIKE_SHIM_LOG || "";
const log = (entry) => {
  if (logPath) appendFileSync(logPath, JSON.stringify(entry) + "\n");
};
const child = spawn(target, process.argv.slice(2), {
  stdio: ["pipe", "inherit", "inherit"],
});
child.on("exit", (code) => process.exit(code ?? 1));

let askSeq = 0;
const askIds = new Set();

function emitAskQuestion(sessionId) {
  const id = `spike-ask-${++askSeq}`;
  askIds.add(id);
  const request = {
    jsonrpc: "2.0",
    id,
    method: "cursor/ask_question",
    params: {
      toolCallId: `tool_spike_${askSeq}`,
      title: "Spike question",
      sessionId,
      questions: [
        {
          id: "q1",
          prompt: "Proceed with option A or option B?",
          options: [
            { id: "opt-a", label: "Option A" },
            { id: "opt-b", label: "Option B" },
          ],
        },
      ],
    },
  };
  process.stdout.write(JSON.stringify(request) + "\n");
  log({ direction: "shim->t3", request });
}

let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx + 1);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      child.stdin.write(line);
      continue;
    }
    if (msg.method === "authenticate" && msg.id !== undefined) {
      process.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n",
      );
      continue;
    }
    if (msg.id !== undefined && msg.method === undefined && askIds.has(msg.id)) {
      // T3's answer (or error) to a shim-emitted ask_question — do not
      // forward to the real agent, it never asked.
      askIds.delete(msg.id);
      log({ direction: "t3->shim", response: msg });
      continue;
    }
    if (
      msg.method === "session/prompt" &&
      JSON.stringify(msg.params?.prompt ?? "").includes("[SPIKE-ASK-QUESTION]")
    ) {
      emitAskQuestion(msg.params?.sessionId);
    }
    child.stdin.write(line);
  }
});
process.stdin.on("end", () => child.stdin.end());
