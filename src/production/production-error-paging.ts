// ---
// relationships:
//   implements: heddle
// ---

import { type SqlitePersistence } from "../persistence/index.js";
import {
  DurablePushoverNotifier,
  NotificationDeliveryError,
  type OperatorPage,
  type ProductionErrorPagePort,
} from "./durable-adapters.js";
import {
  productionErrorIncidentEligible,
  type ProductionErrorAttention,
} from "./error-visibility.js";

export const productionErrorPagePolicy = {
  cooldownMilliseconds: 60_000,
  maximumPagesPerWindow: 3,
  windowMilliseconds: 300_000,
} as const;

const productionErrorPageEffect = "production-error-pushover";
const notificationDeliveryCodes = new Set([
  "notification-delivery-recovery-required",
  "notification-delivery-rejected",
  "notification-delivery-retryable",
]);
export interface ProductionErrorPageRecoveryPort {
  deliveryFailed(
    attention: ProductionErrorAttention,
    error: NotificationDeliveryError,
  ): Promise<void>;
}

export class ProductionErrorPager implements ProductionErrorPagePort {
  readonly #attempts = new Map<string, number[]>();

  public constructor(
    private readonly persistence: SqlitePersistence,
    private readonly notifier: DurablePushoverNotifier,
    private readonly now: () => number = Date.now,
    private readonly recovery?: ProductionErrorPageRecoveryPort,
  ) {}

  async replayPending(): Promise<void> {
    for (const record of this.persistence.listAttention()) {
      const attention = this.#storedProductionError(record);
      if (attention === undefined) continue;
      try {
        await this.send(attention);
      } catch {
        // The durable attention remains the fallback until a later pass retries.
      }
    }
  }

  async send(attention: ProductionErrorAttention): Promise<void> {
    const incidentEligible = productionErrorIncidentEligible(attention.code);
    let pendingIntent = false;
    try {
      if (
        this.persistence.effectCompleted(
          productionErrorPageEffect,
          attention.attentionId,
        )
      ) {
        return;
      }
      pendingIntent = this.persistence.effectIntentRecorded(
        productionErrorPageEffect,
        attention.attentionId,
      );
    } catch (error) {
      if (incidentEligible) throw error;
    }
    const intent = this.#intent(attention, incidentEligible);
    if (pendingIntent) {
      if (incidentEligible) await this.#sendDurably(attention, intent);
      this.#complete(attention.attentionId);
      return;
    }
    const attemptedAt = this.now();
    let admitted: boolean;
    let durableAdmissionAvailable = true;
    try {
      admitted = this.persistence.admitProductionErrorPage({
        attentionId: attention.attentionId,
        attemptedAt,
        code: attention.code,
        ...productionErrorPagePolicy,
      });
    } catch (error) {
      if (incidentEligible) throw error;
      durableAdmissionAvailable = false;
      admitted = this.#admitInMemory(attention.code, attemptedAt);
    }
    if (incidentEligible) {
      if (
        !admitted &&
        !this.persistence.productionErrorPageAttemptRecorded(
          attention.code,
          attention.attentionId,
        )
      ) {
        return;
      }
      this.persistence.recordEffectIntent(
        productionErrorPageEffect,
        attention.attentionId,
        intent,
      );
      await this.#sendDurably(attention, intent);
    } else {
      let deliveryClaimed = admitted;
      if (durableAdmissionAvailable) {
        try {
          deliveryClaimed = this.persistence.claimProductionErrorPageDelivery(
            attention.code,
            attention.attentionId,
          );
        } catch {
          deliveryClaimed = this.#admitInMemory(attention.code, attemptedAt);
        }
      }
      if (!deliveryClaimed) return;
      await this.notifier.sendBeforeDurableIntent(intent);
      this.persistence.recordEffectIntent(
        productionErrorPageEffect,
        attention.attentionId,
        intent,
      );
    }
    this.#complete(attention.attentionId);
  }

  async #sendDurably(
    attention: ProductionErrorAttention,
    intent: OperatorPage,
  ): Promise<void> {
    try {
      await this.notifier.send(intent);
    } catch (error) {
      if (
        error instanceof NotificationDeliveryError &&
        error.disposition !== "retryable" &&
        !notificationDeliveryCodes.has(attention.code)
      ) {
        await this.recovery?.deliveryFailed(attention, error);
      }
      throw error;
    }
  }

  #complete(attentionId: string): void {
    if (
      !this.persistence.recordEffectCompleted(
        productionErrorPageEffect,
        attentionId,
      ) &&
      !this.persistence.effectCompleted(productionErrorPageEffect, attentionId)
    ) {
      throw new Error(
        "Production error page completion lost its durable intent",
      );
    }
  }

  #intent(
    attention: ProductionErrorAttention,
    incidentEligible: boolean,
  ): OperatorPage {
    return {
      attentionId: attention.attentionId,
      level: incidentEligible ? "informational" : "critical",
      message: attention.message,
      scope:
        attention.taskId === null
          ? ("all" as const)
          : (`task:${attention.taskId}` as const),
    };
  }

  #storedProductionError(
    record: ReturnType<SqlitePersistence["listAttention"]>[number],
  ): ProductionErrorAttention | undefined {
    const payload = record.payload;
    if (
      typeof payload !== "object" ||
      payload === null ||
      Array.isArray(payload) ||
      payload["kind"] !== "production-error" ||
      payload["attentionId"] !== record.attentionId ||
      typeof payload["code"] !== "string" ||
      payload["code"].trim() === "" ||
      typeof payload["message"] !== "string" ||
      (payload["taskId"] !== null &&
        (!Number.isSafeInteger(payload["taskId"]) ||
          Number(payload["taskId"]) <= 0))
    ) {
      return undefined;
    }
    return payload as unknown as ProductionErrorAttention;
  }

  #admitInMemory(code: string, attemptedAt: number): boolean {
    const windowStart =
      attemptedAt - productionErrorPagePolicy.windowMilliseconds;
    const current = (this.#attempts.get(code) ?? []).filter(
      (attempt) => attempt > windowStart,
    );
    const lastAttemptAt = current.at(-1);
    if (
      (lastAttemptAt !== undefined &&
        attemptedAt - lastAttemptAt <
          productionErrorPagePolicy.cooldownMilliseconds) ||
      current.length >= productionErrorPagePolicy.maximumPagesPerWindow
    ) {
      this.#attempts.set(code, current);
      return false;
    }
    this.#attempts.set(code, [...current, attemptedAt]);
    return true;
  }
}
