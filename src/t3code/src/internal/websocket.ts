/**
 * The smallest WebSocket surface this library needs, plus an opener that
 * normalises the events of Node's global `WebSocket` and the `ws` package.
 * Both accept `{ headers }` as the constructor's second argument.
 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: never) => void): void;
}

/**
 * Any constructor shaped like the WHATWG `WebSocket`. The second argument is
 * typed `never` so both the global constructor (`protocols`) and the `ws`
 * package (`options`) are assignable; `openWebSocket` passes `{ headers }`.
 */
export type WebSocketConstructor = new (url: string, init?: never) => WebSocketLike;

export interface WebSocketCloseInfo {
  readonly code: number;
  readonly reason: string;
  /** HTTP status of a rejected upgrade, when the implementation exposes it (`ws` does). */
  readonly upgradeStatus?: number;
}

export interface WebSocketEvents {
  onOpen(): void;
  onMessage(data: unknown): void;
  onClose(info: WebSocketCloseInfo): void;
  onError(message: string): void;
}

interface EmitterLike {
  on(
    event: "unexpected-response",
    listener: (req: unknown, res: { statusCode?: number }) => void,
  ): void;
  terminate?(): void;
}

function hasEmitter(socket: WebSocketLike): socket is WebSocketLike & EmitterLike {
  return typeof (socket as { on?: unknown }).on === "function";
}

export function openWebSocket(
  ctor: WebSocketConstructor,
  url: string,
  headers: Record<string, string> | undefined,
  events: WebSocketEvents,
): WebSocketLike {
  const init = headers ? ({ headers } as never) : undefined;
  const socket = new ctor(url, init);
  let upgradeStatus: number | undefined;
  if (hasEmitter(socket)) {
    socket.on("unexpected-response", (_req, res) => {
      upgradeStatus = res.statusCode;
      // Listening to this event takes over the handshake; end it ourselves.
      terminateWebSocket(socket);
    });
  }
  socket.addEventListener("open", () => events.onOpen());
  socket.addEventListener("message", (event: { data?: unknown }) => events.onMessage(event.data));
  socket.addEventListener("error", (event: { message?: unknown; error?: unknown }) => {
    const message =
      typeof event.message === "string" && event.message.length > 0
        ? event.message
        : event.error instanceof Error
          ? event.error.message
          : "websocket error";
    events.onError(message);
  });
  socket.addEventListener("close", (event: { code?: unknown; reason?: unknown }) => {
    const info: WebSocketCloseInfo = {
      code: typeof event.code === "number" ? event.code : 1006,
      reason: typeof event.reason === "string" ? event.reason : "",
      ...(upgradeStatus === undefined ? {} : { upgradeStatus }),
    };
    events.onClose(info);
  });
  return socket;
}

/** Closes with a normal close frame and resolves once the socket reports closed. */
export function closeWebSocket(socket: WebSocketLike, reason: string): Promise<void> {
  return new Promise<void>((resolve) => {
    socket.addEventListener("close", () => resolve());
    try {
      socket.close(1000, reason);
    } catch {
      resolve();
    }
    if (socket.readyState >= 2) resolve(); // CLOSING or CLOSED already
  });
}

/** Closes without waiting for the peer: `terminate` when available, else `close`. */
export function terminateWebSocket(socket: WebSocketLike): void {
  try {
    if (hasEmitter(socket) && typeof socket.terminate === "function") socket.terminate();
    else socket.close(1000, "");
  } catch {
    // Already closed or never opened.
  }
}
