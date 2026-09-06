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

  async send(attention: ProductionErrorAttention): Promise<void> {
    const incidentEligible = productionErrorIncidentEligible(attention.code);
    try {
      if (
        this.persistence.effectCompleted(
          productionErrorPageEffect,
          attention.attentionId,
        )
      ) {
        return;
      }
    } catch (error) {
      if (incidentEligible) throw error;
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
    if (!admitted) return;
    const intent: OperatorPage = {
      attentionId: attention.attentionId,
      level: incidentEligible ? "informational" : "critical",
      message: attention.message,
      scope:
        attention.taskId === null
          ? ("all" as const)
          : (`task:${attention.taskId}` as const),
    };
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
    if (
      !this.persistence.recordEffectCompleted(
        productionErrorPageEffect,
        attention.attentionId,
      ) &&
      !this.persistence.effectCompleted(
        productionErrorPageEffect,
        attention.attentionId,
      )
    ) {
      throw new Error(
        "Production error page completion lost its durable intent",
      );
    }
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
