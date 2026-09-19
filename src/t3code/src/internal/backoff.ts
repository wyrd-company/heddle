/** Exponential backoff with an optional jitter fraction. No T3 knowledge. */
export interface BackoffPolicy {
  readonly initialMs: number;
  readonly factor: number;
  readonly maxMs: number;
  /** Fraction of the delay to randomise, 0 to 1. Default 0. */
  readonly jitter?: number;
}

export const defaultBackoffPolicy: BackoffPolicy = {
  initialMs: 500,
  factor: 1.5,
  maxMs: 5_000,
  jitter: 0.2,
};

export interface Backoff {
  /** The delay for the next attempt, growing on every call until `reset`. */
  next(): number;
  reset(): void;
  readonly attempt: number;
}

export function createBackoff(
  policy: BackoffPolicy = defaultBackoffPolicy,
  random: () => number = Math.random,
): Backoff {
  let attempt = 0;
  return {
    get attempt() {
      return attempt;
    },
    next() {
      const base = Math.min(policy.maxMs, policy.initialMs * policy.factor ** attempt);
      attempt += 1;
      const jitter = policy.jitter ?? 0;
      if (jitter <= 0) return base;
      const spread = base * jitter;
      return Math.max(0, Math.round(base - spread / 2 + random() * spread));
    },
    reset() {
      attempt = 0;
    },
  };
}
