// ---
// relationships:
//   verifies: github-binding-and-intake
// ---
import { createHmac } from "node:crypto";
import {
  request,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
} from "node:http";
import { connect } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { GitHubEventHandler } from "../src/binding/delivery.js";
import { webhookServer } from "../src/service/webhook.js";

const limit = 26_214_400;
const secret = "sample-secret";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listener() {
  const apply = vi.fn(() => Promise.resolve(true));
  const events = new GitHubEventHandler(apply);
  const errors: string[] = [];
  const server = webhookServer(events, () => secret, {
    output: () => undefined,
    error: (message) => errors.push(message),
  });
  cleanups.push(async () => {
    server.closeAllConnections();
    if (server.listening)
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing listener");
  const url = `http://127.0.0.1:${String(address.port)}/webhook/github`;
  return { apply, events, errors, url, server };
}

function signed(body: Uint8Array, event = "issues"): OutgoingHttpHeaders {
  return {
    "x-github-event": event,
    "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
  };
}

function delivery(size?: number) {
  const json = JSON.stringify({
    issue: { node_id: "sample-issue", updated_at: "2026-01-02T00:00:00Z" },
  });
  return Buffer.from(size === undefined ? json : json.padEnd(size, " "));
}

function open(url: string, headers: OutgoingHttpHeaders) {
  let client!: ReturnType<typeof request>;
  const responseHeaders: IncomingHttpHeaders = {};
  const status = new Promise<number>((resolve, reject) => {
    client = request(url, { method: "POST", headers }, (response) => {
      Object.assign(responseHeaders, response.headers);
      response.resume();
      response.once("end", () => {
        resolve(response.statusCode ?? 0);
      });
    });
    client.on("error", reject);
  });
  // Cleanup can reject a pending response after an earlier assertion fails.
  void status.catch(() => undefined);
  cleanups.push(() => {
    client.destroy();
    return Promise.resolve();
  });
  return { client, status, responseHeaders };
}

function send(url: string, body: Uint8Array, headers = signed(body)) {
  const { client, status } = open(url, headers);
  client.end(body);
  return status;
}

it("rejects streamed overflow without Content-Length before binding mutation", async () => {
  const { url, apply } = await listener();
  const body = delivery(limit + 1);
  expect(
    await send(url, body, { ...signed(body), "transfer-encoding": "chunked" }),
  ).toBe(413);
  expect(apply).not.toHaveBeenCalled();
});

it("acknowledges signed ping without invoking the binding mutation handler", async () => {
  const { url, apply } = await listener();
  const body = Buffer.from('{"zen":"Keep it simple"}');
  expect(await send(url, body, signed(body, "ping"))).toBe(202);
  expect(apply).not.toHaveBeenCalled();
});

it("rejects an oversized declared length immediately, before any body arrives", async () => {
  const { url, server, apply } = await listener();
  const observed = new Promise<boolean>((resolve) => {
    server.once("request", (_request, response) => {
      resolve(response.headersSent);
    });
  });
  const { client, status, responseHeaders } = open(url, {
    "content-length": String(limit + 1),
  });
  client.flushHeaders();
  expect(await observed, "413 is sent during header handling").toBe(true);
  expect(await status).toBe(413);
  expect(responseHeaders.connection).toBe("close");
  expect(apply).not.toHaveBeenCalled();
});

it.each(["declared", "chunked"] as const)(
  "dispatches an exactly-at-limit %s body using its original signed bytes",
  async (framing) => {
    const { url, apply } = await listener();
    const body = delivery(limit);
    const framingHeaders =
      framing === "declared"
        ? { "content-length": String(body.length) }
        : { "transfer-encoding": "chunked" };
    expect(await send(url, body, { ...signed(body), ...framingHeaders })).toBe(
      202,
    );
    expect(apply).toHaveBeenCalledExactlyOnceWith({
      event: "issues",
      issueId: "sample-issue",
      updatedAt: "2026-01-02T00:00:00Z",
    });
  },
);

it("rejects streamed overflow before the sender finishes its chunked body", async () => {
  const { url, apply } = await listener();
  const body = delivery(limit + 1);
  const { client, status, responseHeaders } = open(url, {
    ...signed(body),
    "transfer-encoding": "chunked",
  });
  client.write(body.subarray(0, limit));
  client.write(body.subarray(limit));
  expect(await status).toBe(413);
  expect(responseHeaders.connection).toBe("close");
  expect(client.writableEnded).toBe(false);
  expect(apply).not.toHaveBeenCalled();
});

it.each(["ping", "release", "future_event_2"])(
  "acknowledges signed ignored event %s after JSON validation without mutation",
  async (event) => {
    const { url, apply } = await listener();
    const body = Buffer.from('{"action":"created"}');
    expect(await send(url, body, signed(body, event))).toBe(202);
    expect(apply).not.toHaveBeenCalled();
  },
);

it.each(["ping", "release", "issues"])(
  "rejects invalid signatures for %s before JSON validation or mutation",
  async (event) => {
    const { url, apply, errors } = await listener();
    const body = Buffer.from("not JSON");
    for (const signature of [
      "",
      "sha256=invalid",
      `sha256=${"0".repeat(64)}`,
    ]) {
      expect(
        await send(url, body, {
          "x-github-event": event,
          "x-hub-signature-256": signature,
        }),
      ).toBe(500);
    }
    expect(apply).not.toHaveBeenCalled();
    expect(errors).toEqual(
      Array<string>(3).fill("GitHub webhook signature is invalid"),
    );
  },
);

it.each(["ping", "release", "issues"])(
  "rejects validly signed invalid JSON for %s without mutation",
  async (event) => {
    const { url, apply, errors } = await listener();
    const body = Buffer.from("not JSON");
    expect(await send(url, body, signed(body, event))).toBe(500);
    expect(errors).toEqual(["GitHub webhook body is invalid JSON"]);
    expect(apply).not.toHaveBeenCalled();
  },
);

it.each([undefined, "", "   ", "ping, issues", "ping/other", "Ping"])(
  "rejects malformed event metadata %s instead of acknowledging an ignored event",
  async (event) => {
    const { url, apply, errors } = await listener();
    const body = Buffer.from("{}");
    const headers = signed(body);
    if (event === undefined) delete headers["x-github-event"];
    else headers["x-github-event"] = event;
    expect(await send(url, body, headers)).toBe(500);
    expect(errors).toEqual(["GitHub webhook event name is invalid"]);
    expect(apply).not.toHaveBeenCalled();
  },
);

it("preserves supported dispatch failures instead of acknowledging them", async () => {
  const { url, apply, errors } = await listener();
  apply.mockRejectedValue(new Error("sample dispatch failure"));
  expect(await send(url, delivery())).toBe(500);
  expect(apply).toHaveBeenCalledOnce();
  expect(errors).toEqual(["sample dispatch failure"]);
});

it("preserves supported payload validation failures", async () => {
  const { url, apply, errors } = await listener();
  expect(await send(url, Buffer.from("{}"))).toBe(500);
  expect(apply).not.toHaveBeenCalled();
  expect(errors).toEqual(["GitHub issues delivery has no issue identity"]);
});

it("keeps direct delivery unsupported-event rejection", async () => {
  const { events, apply } = await listener();
  await expect(events.deliver("ping", {})).rejects.toThrow(
    "Unsupported GitHub event: ping",
  );
  expect(apply).not.toHaveBeenCalled();
});

it("contains an aborted request without dispatch and accepts the next request", async () => {
  const { url, server, apply } = await listener();
  const aborted = new Promise<void>((resolve) => {
    server.once("request", (incoming) => incoming.once("aborted", resolve));
  });
  const received = new Promise<void>((resolve) => {
    server.once("request", (incoming) =>
      incoming.once("data", () => {
        resolve();
      }),
    );
  });
  const body = delivery();
  const { client, status } = open(url, {
    ...signed(body),
    "content-length": String(body.length),
  });
  const rejected = status.catch(() => undefined);
  client.write(body.subarray(0, 1));
  await received;
  client.destroy();
  await aborted;
  await rejected;
  expect(apply).not.toHaveBeenCalled();
  expect(await send(url, body)).toBe(202);
  expect(apply).toHaveBeenCalledOnce();
});

it("treats an HTTP request without either length framing header as an empty body", async () => {
  const { url, apply, errors } = await listener();
  const body = Buffer.alloc(0);
  const { client, status } = open(url, signed(body));
  client.useChunkedEncodingByDefault = false;
  client.end();
  expect(await status).toBe(500);
  expect(errors).toEqual(["GitHub webhook body is invalid JSON"]);
  expect(apply).not.toHaveBeenCalled();
});

it.each(["ping", "release"])(
  "rejects an invalid signature on valid JSON for ignored event %s",
  async (event) => {
    const { url, apply, errors } = await listener();
    const body = Buffer.from("{}");
    expect(
      await send(url, body, {
        "x-github-event": event,
        "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
      }),
    ).toBe(500);
    expect(errors).toEqual(["GitHub webhook signature is invalid"]);
    expect(apply).not.toHaveBeenCalled();
  },
);

it("flushes pipelined responses before closing an overflowing request socket", async () => {
  const { url, server, apply } = await listener();
  let release: (value: boolean) => void = () => undefined;
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  apply.mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        release = resolve;
        started();
      }),
  );
  const address = new URL(url);
  const socket = connect(Number(address.port), address.hostname);
  const responses: Buffer[] = [];
  const ended = new Promise<void>((resolve, reject) => {
    socket.on("data", (chunk: Buffer) => {
      responses.push(chunk);
    });
    socket.once("end", resolve);
    socket.once("error", reject);
  });
  void ended.catch(() => undefined);
  cleanups.push(() => {
    release(true);
    socket.destroy();
    return Promise.resolve();
  });
  const body = delivery();
  const signature = signed(body)["x-hub-signature-256"];
  socket.write(
    [
      "POST /webhook/github HTTP/1.1",
      "Host: localhost",
      "Connection: keep-alive",
      `Content-Length: ${String(body.length)}`,
      "X-GitHub-Event: issues",
      `X-Hub-Signature-256: ${String(signature)}`,
      "",
      "",
    ].join("\r\n"),
  );
  socket.write(body);
  await firstStarted;
  const overflowRead = new Promise<void>((resolve) => {
    server.once("request", (incoming) => {
      let received = 0;
      incoming.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > limit) setImmediate(resolve);
      });
    });
  });
  const overflow = delivery(limit + 1);
  socket.write(
    [
      "POST /webhook/github HTTP/1.1",
      "Host: localhost",
      "Transfer-Encoding: chunked",
      "",
      "",
    ].join("\r\n"),
  );
  socket.write(`${overflow.length.toString(16)}\r\n`);
  socket.write(overflow);
  socket.write("\r\n0\r\n\r\n");
  await overflowRead;
  release(true);
  const closedWithError = await ended.then(
    () => false,
    () => true,
  );
  const statuses = [
    ...Buffer.concat(responses)
      .toString()
      .matchAll(/HTTP\/1\.1 (\d+)/gu),
  ].map((match) => Number(match[1]));
  expect({ statuses, closedWithError }).toEqual({
    statuses: [202, 413],
    closedWithError: false,
  });
  expect(apply).toHaveBeenCalledOnce();
});
