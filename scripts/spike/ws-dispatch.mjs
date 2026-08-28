#!/usr/bin/env node
// Minimal hand-rolled Effect-RPC-over-WebSocket client for T3 Code.
// Usage: node ws-dispatch.mjs <url> <token> <rpcTag> <payload-json> [--stream-first-n N]
// Sends one Request frame and prints server frames until an Exit for our id.
// Node >= 22 (native WebSocket).

const [url, token, tag, payloadJson] = process.argv.slice(2);
if (!url || !token || !tag || !payloadJson) {
  console.error("usage: ws-dispatch.mjs <ws-url> <token> <rpcTag> <payload-json>");
  process.exit(2);
}
const payload = JSON.parse(payloadJson);

const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
const reqId = "1";
const timeout = setTimeout(() => { console.error("timeout"); process.exit(1); }, 30000);

ws.onopen = () => {
  ws.send(JSON.stringify([{ _tag: "Request", id: reqId, tag, payload, headers: [] }]));
};
ws.onerror = (e) => { console.error("ws error", e.message ?? e); process.exit(1); };
ws.onmessage = (ev) => {
  const data = typeof ev.data === "string" ? ev.data : ev.data.toString();
  let frames;
  try { frames = JSON.parse(data); } catch { console.error("non-json frame:", data.slice(0, 200)); return; }
  if (!Array.isArray(frames)) frames = [frames];
  for (const f of frames) {
    console.log(JSON.stringify(f));
    if (f._tag === "Chunk" && f.requestId === reqId) {
      ws.send(JSON.stringify([{ _tag: "Ack", requestId: reqId }]));
    }
    if ((f._tag === "Exit" || f._tag === "Defect") && (f.requestId === reqId || f._tag === "Defect")) {
      clearTimeout(timeout);
      ws.close();
      process.exit(0);
    }
  }
};
