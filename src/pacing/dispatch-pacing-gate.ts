// ---
// relationships:
//   implements: heddle
// ---

import {
  type DispatchPacingEvaluator,
  type PacingConfiguration,
  type PacingDecision,
  type PacingDispatchRequest,
  type PacingSession,
  PROVIDER_USAGE_WINDOW_MS,
  type ProviderUsageSource,
} from "./types.js";

const requireNonNegativeInteger = (name: string, value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
};

const requireNonNegativeFinite = (name: string, value: number): void => {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative finite number`);
  }
};

const requireNonEmpty = (name: string, value: string): void => {
  if (value.trim() === "") throw new TypeError(`${name} must not be empty`);
};

const validateConfiguration = (configuration: PacingConfiguration): void => {
  requireNonEmpty("defaultProvider", configuration.defaultProvider);
  if (configuration.usageWindowHours !== 5) {
    throw new TypeError("usageWindowHours must be 5");
  }
  requireNonNegativeInteger(
    "maxConcurrentSessions",
    configuration.maxConcurrentSessions,
  );
  requireNonNegativeInteger(
    "subagents.maxDepth",
    configuration.subagents.maxDepth,
  );
  requireNonNegativeInteger(
    "subagents.maxFanOut",
    configuration.subagents.maxFanOut,
  );
  for (const [provider, budget] of Object.entries(
    configuration.providerBudgets,
  )) {
    requireNonEmpty("provider", provider);
    requireNonNegativeFinite(
      `providerBudgets.${provider}.usageLimit`,
      budget.usageLimit,
    );
  }
};

const validateRequest = (request: PacingDispatchRequest): void => {
  requireNonEmpty("sessionId", request.sessionId);
  requireNonEmpty("provider", request.provider);
  if (request.kind === "subagent") {
    requireNonEmpty("parentSessionId", request.parentSessionId);
  }
};

export class DispatchPacingGate implements DispatchPacingEvaluator {
  private readonly configuration: PacingConfiguration;
  public readonly defaultProvider: string;
  private readonly now: () => number;

  public constructor(
    configuration: PacingConfiguration,
    private readonly usage: ProviderUsageSource,
    now: () => number = Date.now,
  ) {
    validateConfiguration(configuration);
    this.configuration = {
      ...configuration,
      providerBudgets: { ...configuration.providerBudgets },
      subagents: { ...configuration.subagents },
    };
    this.defaultProvider = configuration.defaultProvider;
    this.now = now;
  }

  public async evaluate(
    request: PacingDispatchRequest,
    activeSessions: readonly PacingSession[],
  ): Promise<PacingDecision> {
    validateRequest(request);

    if (request.kind === "subagent") {
      const parent = activeSessions.find(
        ({ sessionId }) => sessionId === request.parentSessionId,
      );
      if (parent === undefined) {
        throw new TypeError(
          `Active parent session ${request.parentSessionId} is required`,
        );
      }
      requireNonNegativeInteger("parent depth", parent.depth);
      const requestedDepth = parent.depth + 1;
      if (requestedDepth > this.configuration.subagents.maxDepth) {
        return {
          deferral: {
            limit: this.configuration.subagents.maxDepth,
            reason: "subagent-depth-limit",
            requestedDepth,
          },
          kind: "defer",
        };
      }

      const activeChildren = activeSessions.filter(
        ({ parentSessionId }) => parentSessionId === request.parentSessionId,
      ).length;
      if (activeChildren >= this.configuration.subagents.maxFanOut) {
        return {
          deferral: {
            activeChildren,
            limit: this.configuration.subagents.maxFanOut,
            parentSessionId: request.parentSessionId,
            reason: "subagent-fan-out-limit",
          },
          kind: "defer",
        };
      }
    }

    if (activeSessions.length >= this.configuration.maxConcurrentSessions) {
      return {
        deferral: {
          activeSessions: activeSessions.length,
          limit: this.configuration.maxConcurrentSessions,
          reason: "work-in-progress-limit",
        },
        kind: "defer",
      };
    }

    const budget = this.configuration.providerBudgets[request.provider];
    if (budget === undefined) return { kind: "dispatch" };

    const usage = await this.usage.readFiveHourWindow(request.provider);
    requireNonNegativeFinite(`${request.provider} usage`, usage.used);
    requireNonNegativeInteger(
      `${request.provider} windowStartedAt`,
      usage.windowStartedAt,
    );
    const retryAt = usage.windowStartedAt + PROVIDER_USAGE_WINDOW_MS;
    requireNonNegativeInteger(`${request.provider} window end`, retryAt);
    if (usage.used >= budget.usageLimit && this.now() < retryAt) {
      return {
        deferral: {
          limit: budget.usageLimit,
          provider: request.provider,
          reason: "provider-usage-window",
          retryAt,
          used: usage.used,
        },
        kind: "defer",
      };
    }

    return { kind: "dispatch" };
  }
}
