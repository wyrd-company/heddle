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
  NotificationVerification,
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
import type {
  NotificationDeliveryAttention,
  ProductionErrorAttention,
} from "./error-visibility.js";
import { productionErrorIncidentEligible } from "./error-visibility.js";

export type DurableAttention =
  | BlueprintRepositoryAttention
  | EscalationAttention
  | ProductionErrorAttention
  | ReconcilerAttention
  | SessionObservationAttention;

export interface ProductionErrorPagePort {
  send(attention: ProductionErrorAttention): Promise<void>;
  replayPending(): Promise<void>;
}

const isProductionErrorAttention = (
  attention: DurableAttention,
): attention is ProductionErrorAttention =>
  "kind" in attention && attention.kind === "production-error";

const notificationFailureCodes = new Set([
  "notification-delivery-recovery-required",
  "notification-delivery-rejected",
  "notification-delivery-retryable",
]);

export class DurableAttentionQueue {
  public constructor(
    private readonly persistence: SqlitePersistence,
    private readonly productionErrorPages?: ProductionErrorPagePort,
  ) {}

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
    const productionError = isProductionErrorAttention(attention);
    const floorProductionError =
      productionError && !productionErrorIncidentEligible(attention.code);
    let pageError: unknown;
    if (floorProductionError) {
      try {
        await this.productionErrorPages?.send(attention);
      } catch (error) {
        pageError = error;
      }
    }
    try {
      this.persistence.raiseAttention(
        attention.attentionId,
        JSON.parse(JSON.stringify(attention)) as JsonValue,
      );
    } catch (recordError) {
      if (pageError !== undefined) {
        throw new AggregateError(
          [pageError, recordError],
          "Production error page and durable attention record both failed",
        );
      }
      throw recordError;
    }
    if (productionError && !floorProductionError) {
      try {
        await this.productionErrorPages?.send(attention);
      } catch {
        // The durable console record is the fallback when paging is unavailable.
      }
    }
  }

  async replayProductionErrorPages(): Promise<void> {
    await this.productionErrorPages?.replayPending();
  }

  reopen(attentionId: string): boolean {
    return this.persistence.reopenAttention(attentionId);
  }

  resolve(attentionId: string): boolean {
    return this.persistence.resolveAttention(attentionId);
  }

  async raiseCurrentNotificationFailure(
    attention: NotificationDeliveryAttention,
  ): Promise<void> {
    if (!(await this.has(attention.attentionId))) {
      await this.raise(attention);
    }
    this.reopen(attention.attentionId);
    this.#resolveNotificationFailures(
      attention.notificationStableId,
      attention.attentionId,
    );
  }

  resolveNotificationFailures(notificationStableId: string): void {
    this.#resolveNotificationFailures(notificationStableId);
  }

  #resolveNotificationFailures(
    notificationStableId: string,
    retainedAttentionId?: string,
  ): void {
    for (const record of this.persistence.listAttention()) {
      const payload = record.payload;
      if (
        record.attentionId !== retainedAttentionId &&
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
    return this.persistence.listAttention().map((record) => {
      const payload = record.payload;
      const stableId =
        typeof payload === "object" &&
        payload !== null &&
        !Array.isArray(payload) &&
        typeof payload["notificationStableId"] === "string"
          ? payload["notificationStableId"]
          : undefined;
      return projectProductionAttention(
        record,
        runtimes,
        stableId === undefined
          ? undefined
          : this.persistence.notificationFailure(stableId),
      );
    });
  }
}

export type PushoverMessage = {
  applicationToken: string;
  level: PushoverLevel;
  message: string;
  stableId: string;
  title: string;
  url: string;
  userKey: string;
};

export type PushoverLevel = "critical" | "informational" | "normal";

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
  instanceId?: string;
  level?: PushoverLevel;
  message: string;
  scope?: "all" | `task:${number}`;
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
          priority:
            message.level === "critical"
              ? "1"
              : message.level === "informational"
                ? "-1"
                : "0",
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

  #verification(page: OperatorPage): NotificationVerification | undefined {
    const recipientLabel = this.configuration.recipientLabel?.trim();
    if (recipientLabel === undefined || recipientLabel === "") return undefined;
    const secrets = [
      this.configuration.applicationToken,
      this.configuration.userKey,
    ];
    if (
      [recipientLabel, page.message].some((value) =>
        secrets.some((secret) => secret !== "" && value.includes(secret)),
      )
    ) {
      return undefined;
    }
    return { message: page.message, recipientLabel };
  }

  async send(page: OperatorPage): Promise<void> {
    if (this.persistence.effectCompleted("pushover", page.attentionId)) {
      return;
    }
    const message = this.#message(page);
    const fingerprint = (value: unknown): string =>
      createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const legacyFingerprint = fingerprint({
      applicationToken: message.applicationToken,
      message: message.message,
      stableId: message.stableId,
      title: message.title,
      url: message.url,
      userKey: message.userKey,
    });
    const logicalFingerprint = fingerprint({
      level: message.level,
      message: message.message,
      stableId: message.stableId,
      title: message.title,
      url: message.url,
      userKey: message.userKey,
    });
    const precedingFingerprint = {
      attemptFingerprint: legacyFingerprint,
      logicalFingerprint: fingerprint({
        message: message.message,
        stableId: message.stableId,
        title: message.title,
        url: message.url,
        userKey: message.userKey,
      }),
    };
    const attemptFingerprint = fingerprint(message);
    const verification = this.#verification(page);
    try {
      this.persistence.recordNotificationIntent(
        page.attentionId,
        { attemptFingerprint, logicalFingerprint },
        legacyFingerprint,
        precedingFingerprint,
      );
    } catch (error) {
      if (!(error instanceof LegacyNotificationIntentMismatchError)) {
        throw error;
      }
      const failure = this.persistence.recordNotificationFailure(
        page.attentionId,
        "legacy-intent-unverifiable",
        verification,
      );
      throw new NotificationDeliveryError(
        "operator-action",
        failure.category,
        failure.occurrence,
      );
    }
    let priorFailure = this.persistence.notificationFailure(page.attentionId);
    if (
      priorFailure?.state === "rejected" &&
      verification !== undefined &&
      (priorFailure.recipientLabel === null || priorFailure.message === null)
    ) {
      priorFailure = this.persistence.recordNotificationFailure(
        page.attentionId,
        priorFailure.category,
        verification,
      );
    }
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
      await this.#sendTransport(message);
    } catch (error) {
      if (
        error instanceof NotificationDeliveryError &&
        error.disposition === "permanent" &&
        isNotificationFailureCategory(error.category)
      ) {
        const failure = this.persistence.recordNotificationFailure(
          page.attentionId,
          error.category,
          verification,
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
    if (
      !this.persistence.recordEffectCompleted("pushover", page.attentionId) &&
      !this.persistence.effectCompleted("pushover", page.attentionId)
    ) {
      throw new Error("Pushover completion lost its durable intent");
    }
    this.persistence.clearNotificationRetry(page.attentionId);
  }

  async sendBeforeDurableIntent(page: OperatorPage): Promise<void> {
    await this.#sendTransport(this.#message(page));
  }

  #message(page: OperatorPage): PushoverMessage {
    const scopeValue = page.scope ?? this.#scopeForInstance(page);
    const scope = new globalThis.URL(this.configuration.consoleBaseUrl);
    scope.searchParams.set("view", "lifecycle");
    scope.searchParams.set("scope", scopeValue);
    scope.searchParams.set("attention", page.attentionId);
    const message: PushoverMessage = {
      applicationToken: this.configuration.applicationToken,
      level: page.level ?? "normal",
      message: page.message,
      stableId: page.attentionId,
      title: "Heddle needs attention",
      url: scope.toString(),
      userKey: this.configuration.userKey,
    };
    return message;
  }

  async #sendTransport(message: PushoverMessage): Promise<void> {
    await this.transport.send(message);
    await this.afterTransportSuccess?.(message);
  }

  #scopeForInstance(page: OperatorPage): `task:${number}` {
    if (page.instanceId === undefined) {
      throw new Error(
        `Attention '${page.attentionId}' has neither a production instance nor an explicit scope`,
      );
    }
    const runtimes = this.persistence
      .listReconcilerRuntime()
      .filter(({ instanceId }) => instanceId === page.instanceId);
    if (runtimes.length !== 1) {
      throw new Error(
        `Attention '${page.attentionId}' does not resolve to one production task`,
      );
    }
    return `task:${runtimes[0]!.taskId}`;
  }
}
