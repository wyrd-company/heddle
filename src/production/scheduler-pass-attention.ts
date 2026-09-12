// ---
// relationships:
//   implements: heddle
// ---

import { errorDetail, type ErrorDetail } from "../error-details.js";
import type {
  DurableAttentionRecord,
  SqlitePersistence,
} from "../persistence/index.js";
import type { DurableAttentionQueue } from "./durable-adapters.js";
import {
  productionErrorAttention,
  schedulerPassFailureAttention,
  schedulerPassFailureCode,
} from "./error-visibility.js";

export const schedulerPassAttentionId = (
  record: DurableAttentionRecord,
): string | undefined => {
  const payload = record.payload;
  return typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload) &&
    payload["kind"] === "production-error" &&
    payload["code"] === schedulerPassFailureCode
    ? record.attentionId
    : undefined;
};

export class SchedulerPassAttentionLifecycle {
  public constructor(
    private readonly persistence: SqlitePersistence,
    private readonly attention: DurableAttentionQueue,
  ) {}

  async failure(error: unknown): Promise<void> {
    let episode: number;
    let episodeFirstError: ErrorDetail;
    try {
      const recorded = this.persistence.recordSchedulerPassFailure(
        errorDetail(error),
      );
      episode = recorded.episode;
      episodeFirstError = recorded.episodeFirstError as ErrorDetail;
    } catch (historyError) {
      await this.#raiseWithoutPersistence(error, historyError);
      return;
    }

    const failure = schedulerPassFailureAttention({
      episode,
      error: episodeFirstError,
    });
    if (await this.attention.has(failure.attentionId)) {
      this.attention.reopen(failure.attentionId);
    } else {
      await this.attention.raise(failure);
    }
    for (const attentionId of this.#activeAttentionIds()) {
      if (attentionId !== failure.attentionId) {
        this.attention.resolve(attentionId);
      }
    }
  }

  recovery(): void {
    this.persistence.recoverSchedulerPass(this.#activeAttentionIds());
  }

  #activeAttentionIds(): string[] {
    return this.persistence
      .listAttention()
      .map(schedulerPassAttentionId)
      .filter(
        (attentionId): attentionId is string => attentionId !== undefined,
      );
  }

  async #raiseWithoutPersistence(
    error: unknown,
    historyError: unknown,
  ): Promise<void> {
    const failure = productionErrorAttention({
      code: schedulerPassFailureCode,
      error,
      summary: "Production reconciliation pass failed",
      varyByError: true,
    });
    try {
      await this.attention.raise(failure);
    } catch (attentionError) {
      throw new AggregateError(
        [historyError, attentionError],
        "Scheduler pass failure could not be recorded",
      );
    }
  }
}
