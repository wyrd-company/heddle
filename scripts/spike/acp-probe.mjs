#!/usr/bin/env node
// Direct ACP probe of the cursor agent binary, bypassing T3, to see the raw
// initialize/authenticate behavior. Usage: acp-probe.mjs <binary> [--skip-auth]
import { spawn } from "node:child_process";

const [bin, ...flags] = process.argv.slice(2);
const skipAuth = flags.includes("--skip-auth");
const child = spawn(bin, ["acp"], { stdio: ["pipe", "pipe", "inherit"] });
let id = 0;
const pending = new Map();
function send(method, params) {
  const msgId = ++id;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msgId, method, params }) + "\n");
  return new Promise((resolve) => pending.set(msgId, resolve));
}
let buf = "";
child.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { console.log("RAW:", line.slice(0, 300)); continue; }
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else console.log("NOTIFY:", JSON.stringify(msg).slice(0, 400));
  }
});
const t = setTimeout(() => { console.log("TIMEOUT"); child.kill(); process.exit(1); }, 120000);
const init = await send("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }, clientInfo: { name: "spike-probe", version: "0.0.0" } });
console.log("initialize:", JSON.stringify(init).slice(0, 800));
if (!skipAuth) {
  const auth = await send("authenticate", { methodId: "cursor_login" });
  console.log("authenticate:", JSON.stringify(auth).slice(0, 400));
}
const sess = await send("session/new", { cwd: process.cwd(), mcpServers: [] });
console.log("session/new:", JSON.stringify(sess).slice(0, 400));
const modeId = process.env.ACP_PROBE_MODE;
if (modeId) {
  const m = await send("session/set_mode", { sessionId: sess.result.sessionId, modeId });
  console.log("set_mode:", JSON.stringify(m).slice(0, 200));
}
const promptText = process.env.ACP_PROBE_PROMPT;
if (promptText) {
  const res = await send("session/prompt", { sessionId: sess.result.sessionId, prompt: [{ type: "text", text: promptText }] });
  console.log("session/prompt:", JSON.stringify(res).slice(0, 400));
}
clearTimeout(t); child.kill(); process.exit(0);
