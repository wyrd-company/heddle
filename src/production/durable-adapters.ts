// ---
// relationships:
//   implements: heddle
// ---

import type { ConsoleAttention } from "../console/index.js";
import type { EscalationAttention } from "../mcp-server/index.js";
import type { SessionObservationAttention } from "../control-plane/index.js";
import type { JsonValue, SqlitePersistence } from "../persistence/index.js";
import type { ReconcilerAttention } from "../reconciler/index.js";
import type { PushoverConfiguration } from "./configuration.js";

export type DurableAttention =
  EscalationAttention | ReconcilerAttention | SessionObservationAttention;

export class DurableAttentionQueue {
  public constructor(private readonly persistence: SqlitePersistence) {}

  async has(attentionId: string): Promise<boolean> {
    return this.persistence.hasAttention(attentionId);
  }

  async raise(attention: DurableAttention): Promise<void> {
    this.persistence.raiseAttention(
      attention.attentionId,
      JSON.parse(JSON.stringify(attention)) as JsonValue,
    );
  }

  list(): ConsoleAttention[] {
    return this.persistence.listAttention().map((record) => {
      const payload = record.payload;
      if (
        typeof payload !== "object" ||
        payload === null ||
        Array.isArray(payload) ||
        typeof payload["attentionId"] !== "string"
      ) {
        throw new Error(`Attention '${record.attentionId}' is malformed`);
      }
      const kind =
        typeof payload["kind"] === "string" ? payload["kind"] : "escalation";
      const message =
        typeof payload["message"] === "string"
          ? payload["message"]
          : Array.isArray(payload["questions"]) &&
              typeof payload["questions"][0] === "object" &&
              payload["questions"][0] !== null &&
              !Array.isArray(payload["questions"][0]) &&
              typeof payload["questions"][0]["prompt"] === "string"
            ? payload["questions"][0]["prompt"]
            : "Heddle requires attention";
      return {
        attentionId: payload["attentionId"],
        kind,
        message,
        ...(typeof payload["instanceId"] === "string"
          ? { instanceId: payload["instanceId"] }
          : {}),
        ...(typeof payload["taskId"] === "number"
          ? { taskId: payload["taskId"] }
          : {}),
      };
    });
  }
}

export type PushoverMessage = {
  applicationToken: string;
  message: string;
  stableId: string;
  title: string;
  url: string;
  userKey: string;
};

export interface PushoverTransport {
  send(message: PushoverMessage): Promise<void>;
}

export class HttpPushoverTransport implements PushoverTransport {
  public constructor(
    private readonly apiUrl: string,
    private readonly fetch: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  async send(message: PushoverMessage): Promise<void> {
    const response = await this.fetch(this.apiUrl, {
      body: new globalThis.URLSearchParams({
        message: message.message,
        title: message.title,
        token: message.applicationToken,
        url: message.url,
        user: message.userKey,
      }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(`Pushover returned HTTP ${response.status}`);
    }
  }
}

export class DurablePushoverNotifier {
  public constructor(
    private readonly persistence: SqlitePersistence,
    private readonly configuration: PushoverConfiguration,
    private readonly transport: PushoverTransport,
  ) {}

  async send(attention: EscalationAttention): Promise<void> {
    if (this.persistence.effectCompleted("pushover", attention.attentionId)) {
      return;
    }
    const scope = new globalThis.URL(this.configuration.consoleBaseUrl);
    scope.searchParams.set("view", "lifecycle");
    scope.searchParams.set(
      "scope",
      `task:${attention.instanceId.replace(/^task-/, "")}`,
    );
    scope.searchParams.set("attention", attention.attentionId);
    await this.transport.send({
      applicationToken: this.configuration.applicationToken,
      message: `Heddle escalation in ${attention.stage}`,
      stableId: attention.attentionId,
      title: "Heddle needs attention",
      url: scope.toString(),
      userKey: this.configuration.userKey,
    });
    this.persistence.recordEffectCompleted("pushover", attention.attentionId);
  }
}
