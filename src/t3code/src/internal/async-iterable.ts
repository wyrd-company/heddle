/**
 * A push-to-pull channel: producers `push`, `end`, or `fail`; one consumer
 * pulls through the async iterator. Values are buffered without bound; the
 * `onPull` hook lets the owner apply its own backpressure (for example, send
 * an acknowledgement once the buffer drains below a mark).
 */
export interface Channel<T> extends AsyncIterable<T> {
  push(value: T): void;
  /** Ends the iteration once buffered values are consumed. */
  end(): void;
  /** Ends the iteration with an error once buffered values are consumed. */
  fail(error: unknown): void;
  /** Number of buffered values not yet handed to the consumer. */
  readonly size: number;
  /** `true` once `end` or `fail` has been called. */
  readonly closed: boolean;
  next(): Promise<IteratorResult<T>>;
}

export interface ChannelOptions {
  /** Called after each value is handed to the consumer, with the values still buffered. */
  onPull?: (remaining: number) => void;
  /** Called once when the consumer returns early (before `end`/`fail`). */
  onReturn?: () => void;
}

interface Waiter<T> {
  resolve(result: IteratorResult<T>): void;
  reject(error: unknown): void;
}

export function createChannel<T>(options: ChannelOptions = {}): Channel<T> {
  const buffer: T[] = [];
  let waiter: Waiter<T> | undefined;
  let terminal: { kind: "end" } | { kind: "fail"; error: unknown } | undefined;
  let returned = false;

  const settleTerminal = (w: Waiter<T>): void => {
    if (terminal?.kind === "fail") w.reject(terminal.error);
    else w.resolve({ done: true, value: undefined });
  };

  const next = (): Promise<IteratorResult<T>> => {
    if (buffer.length > 0) {
      const value = buffer.shift() as T;
      options.onPull?.(buffer.length);
      return Promise.resolve({ done: false, value });
    }
    if (terminal) {
      return new Promise((resolve, reject) => settleTerminal({ resolve, reject }));
    }
    return new Promise((resolve, reject) => {
      waiter = { resolve, reject };
    });
  };

  const channel: Channel<T> = {
    push(value) {
      if (terminal || returned) return;
      if (waiter) {
        const w = waiter;
        waiter = undefined;
        w.resolve({ done: false, value });
        options.onPull?.(0);
        return;
      }
      buffer.push(value);
    },
    end() {
      if (terminal) return;
      terminal = { kind: "end" };
      if (waiter) {
        const w = waiter;
        waiter = undefined;
        settleTerminal(w);
      }
    },
    fail(error) {
      if (terminal) return;
      terminal = { kind: "fail", error };
      if (waiter) {
        const w = waiter;
        waiter = undefined;
        settleTerminal(w);
      }
    },
    get size() {
      return buffer.length;
    },
    get closed() {
      return terminal !== undefined;
    },
    next,
    [Symbol.asyncIterator]() {
      return {
        next,
        return(): Promise<IteratorResult<T>> {
          if (!returned) {
            returned = true;
            buffer.length = 0;
            const wasOpen = terminal === undefined;
            terminal ??= { kind: "end" };
            if (waiter) {
              const w = waiter;
              waiter = undefined;
              w.resolve({ done: true, value: undefined });
            }
            if (wasOpen) options.onReturn?.();
          }
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
  return channel;
}

/** Rejects with `onAbort()`'s error when the signal fires while `promise` is pending. */
export function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort: () => unknown,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(onAbort());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(onAbort());
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
