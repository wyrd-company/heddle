// ---
// relationships:
//   implements: heddle
//   references: t3-headless
// ---

import { isIP } from "node:net";

const isLoopbackHostname = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase();
  const unbracketed = normalized.replace(/^\[|\]$/gu, "");
  if (isIP(unbracketed) === 4) return unbracketed.startsWith("127.");
  if (isIP(unbracketed) === 6) return unbracketed === "::1";
  return normalized === "localhost" || normalized.endsWith(".localhost");
};

export const requireWorkflowMcpEndpoint = (value: string): string => {
  let endpoint: InstanceType<typeof globalThis.URL>;
  try {
    endpoint = new globalThis.URL(value);
  } catch {
    throw new TypeError("workflowMcpEndpoint must be an HTTP(S) URL");
  }
  if (
    /\s/u.test(value) ||
    (endpoint.protocol !== "http:" && endpoint.protocol !== "https:")
  ) {
    throw new TypeError("workflowMcpEndpoint must be an HTTP(S) URL");
  }
  if (endpoint.protocol === "http:" && !isLoopbackHostname(endpoint.hostname)) {
    throw new TypeError(
      "workflowMcpEndpoint must use HTTPS unless its hostname is loopback",
    );
  }
  return value;
};
