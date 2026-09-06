// ---
// relationships:
//   implements: heddle
// ---

import { type SqlitePersistence } from "../persistence/index.js";
import {
  DurablePushoverNotifier,
  type OperatorPage,
  type ProductionErrorPagePort,
} from "./durable-adapters.js";
import {
  productionErrorCodeDeclarations,
  productionErrorIncidentEligible,
  type ProductionErrorAttention,
} from "./error-visibility.js";

export const productionErrorPagePolicy = {
  cooldownMilliseconds: 60_000,
  maximumPagesPerWindow: 3,
  windowMilliseconds: 300_000,
} as const;

type PageWindow = {
  attempts: number;
  lastAttemptAt: number;
  startedAt: number;
};

const productionErrorPageEffect = "production-error-pushover";

export class ProductionErrorPager implements ProductionErrorPagePort {
  readonly #windows = new Map<string, PageWindow>();

  public constructor(
    private readonly persistence: SqlitePersistence,
    private readonly notifier: DurablePushoverNotifier,
    private readonly now: () => number = Date.now,
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
      if (incidentEligible) await this.notifier.send(intent);
      this.#complete(attention.attentionId);
      return;
    }
    const attemptedAt = this.now();
    let admitted: boolean;
    try {
      admitted = this.persistence.admitProductionErrorPage({
        attentionId: attention.attentionId,
        attemptedAt,
        code: attention.code,
        ...productionErrorPagePolicy,
      });
    } catch (error) {
      if (incidentEligible) throw error;
      admitted = this.#admitInMemory(attention.code, attemptedAt);
    }
    if (
      !admitted &&
      (!incidentEligible ||
        !this.persistence.productionErrorPageAttemptRecorded(
          attention.code,
          attention.attentionId,
        ))
    ) {
      return;
    }
    if (incidentEligible) {
      this.persistence.recordEffectIntent(
        productionErrorPageEffect,
        attention.attentionId,
        intent,
      );
      await this.notifier.send(intent);
    } else {
      await this.notifier.sendBeforeDurableIntent(intent);
      this.persistence.recordEffectIntent(
        productionErrorPageEffect,
        attention.attentionId,
        intent,
      );
    }
    this.#complete(attention.attentionId);
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
      !Object.hasOwn(productionErrorCodeDeclarations, payload["code"]) ||
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
    const prior = this.#windows.get(code);
    const current =
      prior === undefined ||
      attemptedAt - prior.startedAt >=
        productionErrorPagePolicy.windowMilliseconds
        ? { attempts: 0, lastAttemptAt: -Infinity, startedAt: attemptedAt }
        : prior;
    if (
      attemptedAt - current.lastAttemptAt <
        productionErrorPagePolicy.cooldownMilliseconds ||
      current.attempts >= productionErrorPagePolicy.maximumPagesPerWindow
    ) {
      this.#windows.set(code, current);
      return false;
    }
    this.#windows.set(code, {
      attempts: current.attempts + 1,
      lastAttemptAt: attemptedAt,
      startedAt: current.startedAt,
    });
    return true;
  }
}
