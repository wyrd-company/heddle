// ---
// relationships:
//   implements: heddle
// ---

import nunjucks from "nunjucks";

import type { LifecycleProjection } from "../engine/index.js";
import type { JsonValue } from "../persistence/index.js";

const sortedJson = (value: JsonValue): JsonValue => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortedJson);
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortedJson(value[key]!)]),
  );
};

const environment = (): nunjucks.Environment => {
  const result = new nunjucks.Environment(undefined, {
    autoescape: false,
    throwOnUndefined: true,
  });
  result.addFilter("stableJson", (value: JsonValue) =>
    JSON.stringify(sortedJson(value), undefined, 2),
  );
  return result;
};

export type LifecycleTextContext = {
  lifecycle: LifecycleProjection;
  task: JsonValue;
};

/**
 * Authored text in a blueprint node is a template over what the graph has done
 * so far, so a role or an operator sees the data, not a reference to it.
 */
export const renderLifecycleText = (
  text: string,
  context: LifecycleTextContext,
  label = "text",
): string => {
  try {
    return new nunjucks.Template(text, environment(), label).render(context);
  } catch (error) {
    throw new Error(
      `${label[0]!.toUpperCase()}${label.slice(1)} ${JSON.stringify(text)} failed to render: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};
