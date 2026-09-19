/**
 * Classifies a WebSocket close event: was it a credential rejection (do not
 * retry) or an ordinary drop (reconnect)?
 */
import { T3ConnectionError } from "../errors.js";
import type { WebSocketCloseInfo } from "../internal/websocket.js";

/** A 4xx upgrade or close code 1008 means the credential is wrong: do not retry. */
export function closeError(
  info: WebSocketCloseInfo,
  wasOpen: boolean,
): { error: T3ConnectionError; fatal: boolean } {
  const status = info.upgradeStatus;
  const detail = `${info.code} ${info.reason}`.trim();
  const fatal = (status !== undefined && status >= 400 && status < 500) || info.code === 1008;
  if (fatal) {
    const text =
      status === undefined
        ? `refused the socket: ${detail}`
        : `rejected the upgrade: HTTP ${status}`;
    return { fatal, error: new T3ConnectionError("open_failed", `The server ${text}.`) };
  }
  const reason = wasOpen ? "closed" : "open_failed";
  return { fatal, error: new T3ConnectionError(reason, `The socket ended (${reason}): ${detail}`) };
}
