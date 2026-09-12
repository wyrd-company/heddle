// ---
// relationships:
//   verifies: heddle
// ---

import type {
  PacingConfiguration,
  ProviderUsageSource,
  ProviderUsageWindow,
} from "./types.js";

export class UsageStub implements ProviderUsageSource {
  readonly reads: string[] = [];

  public constructor(
    private readonly windows: Record<string, ProviderUsageWindow>,
  ) {}

  async readFiveHourWindow(provider: string): Promise<ProviderUsageWindow> {
    this.reads.push(provider);
    const window = this.windows[provider];
    if (window === undefined) throw new Error(`No usage for ${provider}`);
    return { ...window };
  }
}

export const configuration = (
  overrides: Partial<PacingConfiguration> = {},
): PacingConfiguration => ({
  defaultProvider: "provider-a",
  maxConcurrentSessions: 2,
  providerBudgets: { "provider-a": { usageLimit: 80 } },
  subagents: { maxDepth: 2, maxFanOut: 2 },
  usageWindowHours: 5,
  ...overrides,
});
