/**
 * Runs against a real T3 Code server. Needs T3_LIVE_URL and T3_LIVE_TOKEN.
 */
import { WebSocket as WsWebSocket } from "ws";
import { describe, expect, it } from "vitest";
import { T3RpcDefectError } from "../../src/errors.js";
import type { WebSocketConstructor } from "../../src/internal/websocket.js";
import { RpcConnection } from "../../src/transport/rpc-connection.js";
import { SocketTransport } from "../../src/transport/socket.js";

const baseUrl = process.env["T3_LIVE_URL"];
const token = process.env["T3_LIVE_TOKEN"];

describe.skipIf(!baseUrl || !token)("live RPC", () => {
  const wsUrl = () => {
    const url = new URL("/ws", baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url;
  };

  it("server.probe over a bearer header upgrade", async () => {
    const rpc = new RpcConnection(
      new SocketTransport({
        url: async () => wsUrl(),
        headers: async () => ({ authorization: `Bearer ${token}` }),
        webSocket: WsWebSocket as unknown as WebSocketConstructor,
      }),
    );
    try {
      const result = await rpc.call("server.probe", {});
      expect(result).toBeDefined();
      await expect(rpc.call("no.such.method", {})).rejects.toBeInstanceOf(T3RpcDefectError);
    } finally {
      await rpc.close();
    }
  });

  it("server.probe over a ticket upgrade with the global WebSocket", async () => {
    const rpc = new RpcConnection(
      new SocketTransport({
        url: async () => {
          const response = await fetch(new URL("/api/auth/websocket-ticket", baseUrl), {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
          });
          const { ticket } = (await response.json()) as { ticket: string };
          const url = wsUrl();
          url.searchParams.set("wsTicket", ticket);
          return url;
        },
      }),
    );
    try {
      await expect(rpc.call("server.probe", {})).resolves.toBeDefined();
      const events: unknown[] = [];
      for await (const event of rpc.stream("subscribeServerLifecycle", {})) {
        events.push(event);
        break;
      }
    } finally {
      await rpc.close();
    }
  });
});
