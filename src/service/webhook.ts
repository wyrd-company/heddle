// ---
// relationships:
//   implements: github-binding-and-intake
// ---
import { createServer, type Server } from "node:http";
import type { GitHubEventHandler } from "../binding/delivery.js";
import type { ServiceIo } from "./service.js";

const bodyLimit = 26_214_400;

/** This listener has no access to generated tools or hook transport. */
export function webhookServer(
  events: GitHubEventHandler,
  secret: () => string,
  io: ServiceIo,
): Server {
  return createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/webhook/github") {
      response.writeHead(404).end();
      return;
    }
    const rejectOverflow = () => {
      response.writeHead(413, { Connection: "close" }).end();
      request.resume();
    };
    if (Number(request.headers["content-length"]) > bodyLimit) {
      rejectOverflow();
      return;
    }
    void (async () => {
      const chunks: Uint8Array[] = [];
      let size = 0;
      // Returning must leave the socket alive long enough to send HTTP 413.
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        const bytes = chunk as Buffer;
        size += bytes.length;
        if (size > bodyLimit) {
          rejectOverflow();
          return;
        }
        chunks.push(bytes);
      }
      await events.webhook(
        String(request.headers["x-github-event"] ?? ""),
        String(request.headers["x-hub-signature-256"] ?? ""),
        Buffer.concat(chunks),
        secret(),
      );
      response.writeHead(202).end();
    })().catch((error: unknown) => {
      io.error(error instanceof Error ? error.message : String(error));
      if (!response.headersSent) response.writeHead(500).end();
    });
  });
}
