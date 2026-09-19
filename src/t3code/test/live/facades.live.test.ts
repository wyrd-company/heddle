/**
 * Facade round trip against a real T3 Code server. Needs T3_LIVE=1,
 * T3_LIVE_URL and T3_LIVE_TOKEN; T3_LIVE_AGENT=1 also runs a real agent turn.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket as WsWebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ShellWatchItem } from "../../src/api/shell.js";
import { T3Client } from "../../src/client.js";
import type { WebSocketConstructor } from "../../src/internal/websocket.js";
import { threadId, type ProjectId, type ThreadId } from "../../src/schemas/common.js";

const baseUrl = process.env["T3_LIVE_URL"];
const token = process.env["T3_LIVE_TOKEN"];
const model = process.env["T3_LIVE_MODEL"] ?? "gpt-5.6-luna";
const enabled = process.env["T3_LIVE"] === "1" && Boolean(baseUrl) && Boolean(token);
const agent = process.env["T3_LIVE_AGENT"] === "1";
/** Run the two-turn queued scenario instead of the single turn (two agent turns, not three). */
const queued = process.env["T3_LIVE_QUEUED"] === "1";

const kindOf = (item: { kind: string; event?: unknown }): string =>
  item.kind === "event" ? `event:${String((item.event as { type?: string }).type)}` : item.kind;

describe.skipIf(!enabled)("live facades", () => {
  let client: T3Client;
  let workspaceRoot: string;
  let projectId: ProjectId;
  const id: ThreadId = threadId(randomUUID());

  beforeAll(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "t3code-client-live-"));
    client = T3Client.create({
      baseUrl: baseUrl ?? "",
      accessToken: token ?? "",
      clientLabel: "t3code-client-live",
      webSocket: WsWebSocket as unknown as WebSocketConstructor,
    });
  });

  afterAll(async () => {
    try {
      await client.threads.delete(id);
      if (projectId) await client.projects.delete(projectId, { force: true });
    } finally {
      await client.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("ensures a project idempotently", async () => {
    const project = await client.projects.ensure({ workspaceRoot, title: "live sample" });
    projectId = project.id;
    const again = await client.projects.ensure({
      workspaceRoot: `${workspaceRoot}/`,
      title: "live sample",
    });
    expect(again.id).toBe(project.id);
    expect(await client.projects.findByWorkspaceRoot(workspaceRoot)).toMatchObject({
      id: project.id,
    });
  });

  it("ensures a thread idempotently and reads its detail", async () => {
    const input = {
      threadId: id,
      projectId,
      title: "live sample thread",
      modelSelection: { instanceId: "codex" as never, model },
      runtimeMode: "auto" as const,
    };
    const thread = await client.threads.ensure(input);
    expect(thread.id).toBe(id);
    expect(thread.runtimeMode).toBe("auto");
    const again = await client.threads.ensure({ ...input, title: "ignored" });
    expect(again.title).toBe("live sample thread");
    const detail = await client.threads.detail(id);
    expect(detail.thread.id).toBe(id);
    expect(client.threads.phase(thread)).toBe("idle");
    expect(await client.threads.pendingRequests(id)).toEqual([]);
  });

  it("sees the thread on the shell watch", async () => {
    const controller = new AbortController();
    const seen: ShellWatchItem[] = [];
    const watching = (async () => {
      for await (const item of client.shell.watch({ signal: controller.signal })) {
        seen.push(item);
        if (item.kind === "thread-upserted" && item.thread.id === id) controller.abort();
      }
    })();
    // Wait for the snapshot before causing the event so it arrives live.
    while (!seen.some((item) => item.kind === "snapshot"))
      await new Promise((r) => setTimeout(r, 20));
    await client.threads.update(id, { title: "live sample thread (renamed)" });
    await watching;
    expect(seen.some((item) => item.kind === "thread-upserted" && item.thread.id === id)).toBe(
      true,
    );
  });

  it.skipIf(!agent || queued)(
    "runs a turn to completion",
    async () => {
      const started = Date.now();
      const turn = await client.threads.startTurn({
        threadId: id,
        text: "Reply with exactly the word pong and nothing else.",
      });
      const kinds: string[] = [];
      const consume = (async () => {
        for await (const item of turn.events()) kinds.push(kindOf(item));
      })();
      const outcome = await turn.completion;
      await consume;
      console.info(`turn settled in ${Date.now() - started} ms`, kinds);
      expect(outcome.state).toBe("completed");
      expect(outcome.turnId).not.toBeNull();
      expect(outcome.assistantMessage?.text.toLowerCase()).toContain("pong");
      expect(kinds.at(-1)).toBe("turn-settled");
    },
    180_000,
  );

  it.skipIf(!agent || !queued)(
    "a turn started while another is starting is folded into that turn and both settle",
    async () => {
      const first = await client.threads.startTurn({
        threadId: id,
        text: "Count slowly from one to five, one number per line, then stop.",
      });
      const second = await client.threads.startTurn({
        threadId: id,
        text: "Reply with exactly the word marmalade and nothing else.",
      });
      const seen: string[] = [];
      const consume = (async () => {
        for await (const item of second.events()) {
          const detail =
            item.kind === "event"
              ? JSON.stringify((item.event as { payload?: unknown }).payload).slice(0, 160)
              : "";
          seen.push(`${kindOf(item)} ${detail}`);
        }
      })();
      const [one, two] = await Promise.all([first.completion, second.completion]);
      await consume;
      console.info("second turn saw", seen);
      console.info("outcomes", {
        first: { turnId: one.turnId, text: one.assistantMessage?.text },
        second: { turnId: two.turnId, text: two.assistantMessage?.text },
      });
      expect(one.state).toBe("completed");
      expect(two.state).toBe("completed");
      expect(one.turnId).not.toBeNull();
      // Providers steer a message sent during an active turn into that turn.
      expect(two.turnId).toBe(one.turnId);
      expect(two.assistantMessage?.text.toLowerCase()).toContain("marmalade");
    },
    300_000,
  );
});
