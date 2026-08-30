// ---
// relationships:
//   implements: heddle
// ---

import { createHash } from "node:crypto";

import type { EscalationAttention } from "../mcp-server/index.js";
import type { SessionObservationAttention } from "../control-plane/index.js";
import type { JsonValue, SqlitePersistence } from "../persistence/index.js";
import type { ReconcilerAttention } from "../reconciler/index.js";
import type { BlueprintRepositoryAttention } from "./blueprint-repository.js";
import type { PushoverConfiguration } from "./configuration.js";
import { projectProductionAttention } from "./attention-projection.js";

export type DurableAttention =
  | BlueprintRepositoryAttention
  | EscalationAttention
  | ReconcilerAttention
  | SessionObservationAttention;

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

  resolve(attentionId: string): boolean {
    return this.persistence.resolveAttention(attentionId);
  }

  list() {
    const runtimes = this.persistence.listReconcilerRuntime();
    return this.persistence
      .listAttention()
      .map((record) => projectProductionAttention(record, runtimes));
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
    private readonly afterTransportSuccess?: (
      message: PushoverMessage,
    ) => Promise<void> | void,
  ) {}

  async send(attention: EscalationAttention): Promise<void> {
    if (this.persistence.effectCompleted("pushover", attention.attentionId)) {
      return;
    }
    const runtimes = this.persistence
      .listReconcilerRuntime()
      .filter(({ instanceId }) => instanceId === attention.instanceId);
    if (runtimes.length !== 1) {
      throw new Error(
        `Escalation '${attention.attentionId}' does not resolve to one production task`,
      );
    }
    const scope = new globalThis.URL(this.configuration.consoleBaseUrl);
    scope.searchParams.set("view", "lifecycle");
    scope.searchParams.set("scope", `task:${runtimes[0]!.taskId}`);
    scope.searchParams.set("attention", attention.attentionId);
    const message: PushoverMessage = {
      applicationToken: this.configuration.applicationToken,
      message: `Heddle escalation in ${attention.stage}`,
      stableId: attention.attentionId,
      title: "Heddle needs attention",
      url: scope.toString(),
      userKey: this.configuration.userKey,
    };
    const messageFingerprint = createHash("sha256")
      .update(JSON.stringify(message))
      .digest("hex");
    this.persistence.recordEffectIntent("pushover", attention.attentionId, {
      messageFingerprint,
    });
    await this.transport.send(message);
    await this.afterTransportSuccess?.(message);
    if (
      !this.persistence.recordEffectCompleted(
        "pushover",
        attention.attentionId,
      ) &&
      !this.persistence.effectCompleted("pushover", attention.attentionId)
    ) {
      throw new Error("Pushover completion lost its durable intent");
    }
  }
}
