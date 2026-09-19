/** Injectable time source so tests can pin timestamps. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function nowIso(clock: Clock = systemClock): string {
  return clock.now().toISOString();
}
