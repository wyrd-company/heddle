/** Optional logging seam. The default logger discards everything. */
export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export function consoleLogger(prefix = "t3code-client"): Logger {
  const line = (level: string, message: string, data?: Record<string, unknown>) =>
    data
      ? `[${prefix}] ${level} ${message} ${JSON.stringify(data)}`
      : `[${prefix}] ${level} ${message}`;
  return {
    debug: (m, d) => console.debug(line("debug", m, d)),
    info: (m, d) => console.info(line("info", m, d)),
    warn: (m, d) => console.warn(line("warn", m, d)),
    error: (m, d) => console.error(line("error", m, d)),
  };
}
