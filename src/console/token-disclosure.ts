// ---
// relationships:
//   implements: heddle
// ---

export class ConsoleTokenDisclosureError extends Error {
  constructor() {
    super(
      "Console data is unavailable because it contains protected session data",
    );
    this.name = "ConsoleTokenDisclosureError";
  }
}

const protectedToken = (tokens: readonly string[]): readonly string[] => {
  if (tokens.some((token) => token.length === 0 || /\s/.test(token))) {
    throw new ConsoleTokenDisclosureError();
  }
  return tokens;
};

const containsToken = (value: unknown, tokens: readonly string[]): boolean => {
  if (typeof value === "string") {
    return tokens.some((token) => value.includes(token));
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsToken(item, tokens));
  }
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(
    ([key, item]) =>
      tokens.some((token) => key.includes(token)) ||
      containsToken(item, tokens),
  );
};

export const assertConsoleTokenAbsent = (
  value: unknown,
  tokens: readonly string[],
): void => {
  const protectedTokens = protectedToken(tokens);
  if (containsToken(value, protectedTokens)) {
    throw new ConsoleTokenDisclosureError();
  }
};
