// ---
// relationships:
//   implements: node-types
// ---
import type { PassInvocation } from "./types.js";
export class PassWatchState {
  synchronized = false;
  readonly controller = new AbortController();
  readonly ready: Promise<void>;
  resolve = (): void => {
    /* Installed by the synchronous Promise initializer. */
  };
  reject: (error: unknown) => void = (): void => {
    /* Installed by the synchronous Promise initializer. */
  };
  constructor(readonly item: PassInvocation) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    // Startup errors are also observed by the service's run-failure handler.
    void this.ready.catch(() => {
      /* recover() receives the original rejection. */
    });
  }
}
