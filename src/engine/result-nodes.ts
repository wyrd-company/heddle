// ---
// relationships:
//   implements:
//     - node-types
//     - engine-and-run-model
// ---
import jsonata from "jsonata";
import type { Data, EngineNode } from "./types.js";

export const terminalResult: EngineNode = ({ nodeId, params, context }) => {
  if (context["_terminalResult"] !== undefined)
    throw new Error("A run cannot reach multiple terminal results");
  const value = params["value"];
  if (value === undefined) throw new Error("Terminal result value is missing");
  context["_terminalResult"] = { nodeId, value };
  context["result"] = value;
  return Promise.resolve(value);
};

export const aggregate: EngineNode = async ({ params, context }) => {
  const entries: [string, unknown][] = [];
  for (const [name, binding] of Object.entries(
    params["bindings"] as Record<string, { node: string; path?: string }>,
  )) {
    if (!Object.hasOwn(context, `_outputs.${binding.node}`))
      throw new Error(`Aggregate predecessor is incomplete: ${binding.node}`);
    const source = context[`_outputs.${binding.node}`];
    const value: unknown =
      binding.path === undefined
        ? source
        : await jsonata(binding.path).evaluate(source);
    if (value === undefined)
      throw new Error(`Aggregate binding has no value: ${name}`);
    entries.push([name, value]);
  }
  return Object.fromEntries(entries);
};

/** Terminal data owns the final result key even if an authored node has that id. */
export function terminalContext(context: Data): Data {
  const terminal = context["_terminalResult"] as { value: unknown } | undefined;
  return terminal === undefined
    ? context
    : { ...context, result: terminal.value };
}
