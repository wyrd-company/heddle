// ---
// relationships:
//   implements: agent-tools
// ---
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HookSessions } from "./sessions.js";

/** Local plugin transport; generated endpoint credentials never leave the service. */
export class HookServer {
  constructor(
    private readonly sessions: HookSessions,
    private readonly origin: string,
  ) {}

  async decide(sessionId: string): Promise<Record<string, unknown>> {
    const binding = this.sessions.resolve(sessionId);
    if (!binding) return {};
    const response = await fetch(
      new URL(binding.path + "/policy", this.origin),
      {
        headers: { authorization: `Bearer ${binding.token}` },
        redirect: "error",
      },
    );
    const body = await response.text();
    // Handoff can retire the occurrence while its policy request is in flight.
    const current = this.sessions.resolve(sessionId);
    if (current?.path !== binding.path) return {};
    if (!response.ok)
      throw new Error(
        `Cannot read handoff requirement (${String(response.status)})`,
      );
    const policy = JSON.parse(body) as {
      policy: string;
      requirement: string;
    };
    if (policy.policy === "allow") return {};
    if (
      policy.policy !== "require-handoff" ||
      typeof policy.requirement !== "string"
    )
      throw new Error("Unknown turn-end policy");
    return { decision: "block", reason: policy.requirement };
  }

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (request.method !== "POST" || request.url !== "/hook/stop") {
      response.writeHead(404).end();
      return;
    }
    try {
      let input = "";
      for await (const chunk of request) input += String(chunk);
      const event = JSON.parse(input) as { session_id?: unknown };
      if (typeof event.session_id !== "string" || !event.session_id.length)
        throw new Error("Stop hook requires session_id");
      const decision = await this.decide(event.session_id);
      response
        .writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        })
        .end(JSON.stringify(decision));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" }).end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}
