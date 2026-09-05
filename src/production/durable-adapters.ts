// ---
// relationships:
//   implements: heddle
// ---

import { createHash } from "node:crypto";

import { MAXIMUM_CONSOLE_ATTENTION_IDENTIFIER_LENGTH } from "../console/index.js";
import type { EscalationAttention } from "../mcp-server/index.js";
import type { SessionObservationAttention } from "../control-plane/index.js";
import type {
  JsonValue,
  NotificationFailureCategory,
  NotificationRetryCategory,
  SqlitePersistence,
} from "../persistence/index.js";
import {
  isNotificationFailureCategory,
  isNotificationRetryCategory,
  LegacyNotificationIntentMismatchError,
} from "../persistence/index.js";
import type { ReconcilerAttention } from "../reconciler/index.js";
import type { BlueprintRepositoryAttention } from "./blueprint-repository.js";
import type { PushoverConfiguration } from "./configuration.js";
import { projectProductionAttention } from "./attention-projection.js";
import type { ProductionErrorAttention } from "./error-visibility.js";

export type DurableAttention =
  | BlueprintRepositoryAttention
  | EscalationAttention
  | ProductionErrorAttention
  | ReconcilerAttention
  | SessionObservationAttention;

export class DurableAttentionQueue {
  public constructor(private readonly persistence: SqlitePersistence) {}

  async has(attentionId: string): Promise<boolean> {
    return this.persistence.hasAttention(attentionId);
  }

  async raise(attention: DurableAttention): Promise<void> {
    if (
      attention.attentionId.length > MAXIMUM_CONSOLE_ATTENTION_IDENTIFIER_LENGTH
    ) {
      throw new Error(
        `Attention '${attention.attentionId}' exceeds the console attention identity bound of ${MAXIMUM_CONSOLE_ATTENTION_IDENTIFIER_LENGTH} characters`,
      );
    }
    this.persistence.raiseAttention(
      attention.attentionId,
      JSON.parse(JSON.stringify(attention)) as JsonValue,
    );
  }

  reopen(attentionId: string): boolean {
    return this.persistence.reopenAttention(attentionId);
  }

  resolve(attentionId: string): boolean {
    return this.persistence.resolveAttention(attentionId);
  }

  resolveNotificationFailures(notificationStableId: string): void {
    const notificationFailureCodes = new Set([
      "notification-delivery-recovery-required",
      "notification-delivery-rejected",
      "notification-delivery-retryable",
    ]);
    for (const record of this.persistence.listAttention()) {
      const payload = record.payload;
      if (
        typeof payload === "object" &&
        payload !== null &&
        !Array.isArray(payload) &&
        payload["kind"] === "production-error" &&
        notificationFailureCodes.has(String(payload["code"])) &&
        payload["notificationStableId"] === notificationStableId
      ) {
        this.persistence.resolveAttention(record.attentionId);
      }
    }
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

export type NotificationDeliveryFailureCategory =
  NotificationFailureCategory | NotificationRetryCategory;

const pushoverRetryDelayMilliseconds = 5_000;

export class NotificationDeliveryError extends Error {
  public constructor(
    public readonly disposition: "operator-action" | "permanent" | "retryable",
    public readonly category: NotificationDeliveryFailureCategory,
    public readonly occurrence?: number,
  ) {
    super(`Notification delivery ${disposition} failure: ${category}`);
    this.name = "NotificationDeliveryError";
  }
}

export type OperatorPage = {
  attentionId: string;
  instanceId: string;
  message: string;
};

export class HttpPushoverTransport implements PushoverTransport {
  public constructor(
    private readonly apiUrl: string,
    private readonly fetch: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  async send(message: PushoverMessage): Promise<void> {
    let response: Awaited<ReturnType<typeof globalThis.fetch>>;
    try {
      response = await this.fetch(this.apiUrl, {
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
    } catch {
      throw new NotificationDeliveryError("retryable", "network-failure");
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      if (response.status >= 400 && response.status < 500) {
        throw new NotificationDeliveryError(
          "permanent",
          response.status === 429
            ? "provider-quota-exceeded"
            : "request-rejected",
        );
      }
      throw new NotificationDeliveryError("retryable", "invalid-response");
    }
    if (
      response.status === 200 &&
      typeof payload === "object" &&
      payload !== null &&
      !Array.isArray(payload) &&
      (payload as Record<string, unknown>)["status"] === 1
    ) {
      return;
    }
    if (
      response.status >= 500 ||
      (response.status >= 300 && response.status < 400)
    ) {
      throw new NotificationDeliveryError("retryable", "provider-unavailable");
    }
    const fields =
      typeof payload === "object" && payload !== null && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {};
    const category: NotificationFailureCategory =
      response.status === 429
        ? "provider-quota-exceeded"
        : Object.hasOwn(fields, "token")
          ? "application-credential-rejected"
          : Object.hasOwn(fields, "user")
            ? "recipient-rejected"
            : "request-rejected";
    throw new NotificationDeliveryError("permanent", category);
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
    private readonly now: () => number = Date.now,
  ) {}

  async send(page: OperatorPage): Promise<void> {
    if (this.persistence.effectCompleted("pushover", page.attentionId)) {
      return;
    }
    const runtimes = this.persistence
      .listReconcilerRuntime()
      .filter(({ instanceId }) => instanceId === page.instanceId);
    if (runtimes.length !== 1) {
      throw new Error(
        `Attention '${page.attentionId}' does not resolve to one production task`,
      );
    }
    const scope = new globalThis.URL(this.configuration.consoleBaseUrl);
    scope.searchParams.set("view", "lifecycle");
    scope.searchParams.set("scope", `task:${runtimes[0]!.taskId}`);
    scope.searchParams.set("attention", page.attentionId);
    const message: PushoverMessage = {
      applicationToken: this.configuration.applicationToken,
      message: page.message,
      stableId: page.attentionId,
      title: "Heddle needs attention",
      url: scope.toString(),
      userKey: this.configuration.userKey,
    };
    const fingerprint = (value: unknown): string =>
      createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const legacyFingerprint = fingerprint(message);
    const logicalFingerprint = fingerprint({
      message: message.message,
      stableId: message.stableId,
      title: message.title,
      url: message.url,
      userKey: message.userKey,
    });
    const attemptFingerprint = legacyFingerprint;
    try {
      this.persistence.recordNotificationIntent(
        page.attentionId,
        { attemptFingerprint, logicalFingerprint },
        legacyFingerprint,
      );
    } catch (error) {
      if (!(error instanceof LegacyNotificationIntentMismatchError)) {
        throw error;
      }
      const failure = this.persistence.recordNotificationFailure(
        page.attentionId,
        "legacy-intent-unverifiable",
      );
      throw new NotificationDeliveryError(
        "operator-action",
        failure.category,
        failure.occurrence,
      );
    }
    const priorFailure = this.persistence.notificationFailure(page.attentionId);
    if (priorFailure?.state === "rejected") {
      throw new NotificationDeliveryError(
        "permanent",
        priorFailure.category,
        priorFailure.occurrence,
      );
    }
    const retry = this.persistence.notificationRetry(page.attentionId);
    if (retry !== undefined && this.now() < retry.retryNotBefore) {
      throw new NotificationDeliveryError("retryable", retry.category);
    }
    try {
      await this.transport.send(message);
    } catch (error) {
      if (
        error instanceof NotificationDeliveryError &&
        error.disposition === "permanent" &&
        isNotificationFailureCategory(error.category)
      ) {
        const failure = this.persistence.recordNotificationFailure(
          page.attentionId,
          error.category,
        );
        this.persistence.clearNotificationRetry(page.attentionId);
        throw new NotificationDeliveryError(
          "permanent",
          failure.category,
          failure.occurrence,
        );
      }
      const retryable =
        error instanceof NotificationDeliveryError
          ? error
          : new NotificationDeliveryError("retryable", "transport-failure");
      if (
        retryable.disposition === "retryable" &&
        isNotificationRetryCategory(retryable.category)
      ) {
        this.persistence.recordNotificationRetry(
          page.attentionId,
          retryable.category,
          this.now() + pushoverRetryDelayMilliseconds,
        );
      }
      throw retryable;
    }
    await this.afterTransportSuccess?.(message);
    if (
      !this.persistence.recordEffectCompleted("pushover", page.attentionId) &&
      !this.persistence.effectCompleted("pushover", page.attentionId)
    ) {
      throw new Error("Pushover completion lost its durable intent");
    }
    this.persistence.clearNotificationRetry(page.attentionId);
  }
}
