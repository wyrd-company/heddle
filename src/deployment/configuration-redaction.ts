// ---
// relationships:
//   implements: heddle
// ---

const redactedValue = "[REDACTED]";
const secretFieldNames = new Set([
  "accessToken",
  "applicationToken",
  "userKey",
]);

export const configurationSecretValues = (value: unknown): string[] => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [];
  }
  const root = value as Record<string, unknown>;
  const strings: string[] = [];
  for (const [section, names] of [
    ["t3", ["accessToken"]],
    ["pushover", ["applicationToken", "userKey"]],
  ] as const) {
    const candidate = root[section];
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      continue;
    }
    for (const name of names) {
      const secret = (candidate as Record<string, unknown>)[name];
      if (typeof secret === "string" && secret !== "") strings.push(secret);
    }
  }
  return strings;
};

export const redactConfigurationText = (
  message: string,
  secrets: readonly string[],
): string =>
  [...new Set(secrets)]
    .sort((left, right) => right.length - left.length)
    .reduce(
      (result, secret) => result.split(secret).join(redactedValue),
      message,
    );

export const redactedConfigurationValue = (
  value: unknown,
  secrets: readonly string[],
): unknown => {
  if (typeof value === "string") return redactConfigurationText(value, secrets);
  if (Array.isArray(value))
    return value.map((child) => redactedConfigurationValue(child, secrets));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      redactConfigurationText(key, secrets),
      secretFieldNames.has(key)
        ? redactedValue
        : redactedConfigurationValue(child, secrets),
    ]),
  );
};
