// ---
// relationships:
//   verifies: heddle
// ---

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import process from "node:process";
import { URL } from "node:url";

const accessToken = "sample-access-token";
const ticket = "qualification-ticket";

const server = createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${accessToken}`) {
    response.writeHead(401).end();
    return;
  }
  if (request.method === "GET" && request.url === "/api/orchestration/shell") {
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        projects: [
          {
            id: "shared-project",
            title: "Shared records",
            workspaceRoot: "/workspaces/heddle",
          },
        ],
        threads: [],
      }),
    );
    return;
  }
  if (
    request.method !== "POST" ||
    request.url !== "/api/auth/websocket-ticket"
  ) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": "application/json" }).end(
    JSON.stringify({
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ticket,
    }),
  );
});

const responseFrame = (requestId) => {
  const payload = Buffer.from(
    JSON.stringify({
      _tag: "Exit",
      exit: {
        _tag: "Success",
        value: {
          providers: [
            {
              availability: "available",
              displayName: "Workbench Alpha",
              driver: "cursor",
              enabled: true,
              installed: true,
              instanceId: "cursor",
              models: [
                {
                  isCustom: false,
                  name: "Sample Model",
                  slug: "sample-model",
                },
              ],
              status: "ready",
              version: "2026.08.25-3e8eec8",
            },
          ],
        },
      },
      requestId,
    }),
  );
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  const header = Buffer.allocUnsafe(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
};

const readRequest = (source) => {
  if (source.length < 6 || (source[0] & 0x0f) !== 1) return undefined;
  const encodedLength = source[1] & 0x7f;
  let offset = 2;
  let length = encodedLength;
  if (encodedLength === 126) {
    if (source.length < 8) return undefined;
    length = source.readUInt16BE(offset);
    offset += 2;
  }
  if (source.length < offset + 4 + length) return undefined;
  const mask = source.subarray(offset, offset + 4);
  offset += 4;
  const payload = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index += 1) {
    payload[index] = source[offset + index] ^ mask[index % 4];
  }
  return JSON.parse(payload.toString("utf8"));
};

server.on("upgrade", (request, socket) => {
  const url = new URL(request.url ?? "", "http://t3.qualification");
  const webSocketKey = request.headers["sec-websocket-key"];
  if (
    url.pathname !== "/ws" ||
    url.searchParams.get("wsTicket") !== ticket ||
    typeof webSocketKey !== "string"
  ) {
    socket.destroy();
    return;
  }
  const accept = createHash("sha1")
    .update(`${webSocketKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  let buffered = Buffer.alloc(0);
  let responded = false;
  socket.on("data", (chunk) => {
    if (responded) return;
    buffered = Buffer.concat([buffered, chunk]);
    const message = readRequest(buffered);
    if (message === undefined) return;
    if (
      message._tag !== "Request" ||
      message.tag !== "server.getConfig" ||
      typeof message.id !== "string"
    ) {
      socket.destroy();
      return;
    }
    responded = true;
    socket.write(responseFrame(message.id), () => socket.end());
  });
});

server.listen(0, "0.0.0.0", () => {
  const address = server.address();
  if (address === null || typeof address === "string") process.exit(1);
  process.stdout.write(`${address.port}\n`);
});

const stop = () => server.close(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
