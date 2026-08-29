// ---
// relationships:
//   implements: heddle
// ---

export const PROVIDER_USAGE_WINDOW_MS = 5 * 60 * 60 * 1_000;

export interface ProviderUsageBudget {
  usageLimit: number;
}

export interface PacingConfiguration {
  defaultProvider: string;
  maxConcurrentSessions: number;
  providerBudgets: Readonly<Record<string, ProviderUsageBudget>>;
  subagents: {
    maxDepth: number;
    maxFanOut: number;
  };
  usageWindowHours: 5;
}

export interface ProviderUsageWindow {
  used: number;
  windowStartedAt: number;
}

export interface ProviderUsageSource {
  readFiveHourWindow(provider: string): Promise<ProviderUsageWindow>;
}

export interface PacingSession {
  depth: number;
  parentSessionId?: string;
  provider?: string;
  sessionId: string;
}

export type PacingDispatchRequest =
  | {
      kind: "task";
      provider: string;
      sessionId: string;
    }
  | {
      depth: number;
      kind: "subagent";
      parentSessionId: string;
      provider: string;
      sessionId: string;
    };

export type PacingDeferral =
  | {
      activeSessions: number;
      limit: number;
      reason: "work-in-progress-limit";
    }
  | {
      limit: number;
      provider: string;
      reason: "provider-usage-window";
      retryAt: number;
      used: number;
    }
  | {
      limit: number;
      reason: "subagent-depth-limit";
      requestedDepth: number;
    }
  | {
      activeChildren: number;
      limit: number;
      parentSessionId: string;
      reason: "subagent-fan-out-limit";
    };

export type PacingDecision =
  { kind: "dispatch" } | { deferral: PacingDeferral; kind: "defer" };

export interface DispatchPacingEvaluator {
  readonly defaultProvider: string;
  evaluate(
    request: PacingDispatchRequest,
    activeSessions: readonly PacingSession[],
  ): Promise<PacingDecision>;
}
