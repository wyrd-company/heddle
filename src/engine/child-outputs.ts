// ---
// relationships:
//   implements: engine-and-run-model
// ---
import type { WorkflowBlueprint } from "flowcraft";
import jsonata from "jsonata";
import type { Awaiting, Data, Run } from "./types.js";

export async function childOutputs(
  child: Run,
  awaiting: Awaiting,
): Promise<Data> {
  const declared =
    (child.blueprint as WorkflowBlueprint & { outputs?: Data }).outputs ?? {};
  const mapping = awaiting.details["outputs"] as
    Record<string, string> | undefined;
  if (mapping === undefined)
    return Object.fromEntries(
      Object.keys(declared).map((key) => [
        key,
        Object.hasOwn(child.context, key) ? child.context[key] : undefined,
      ]),
    );
  return Object.fromEntries(
    await Promise.all(
      Object.entries(mapping).map(
        async ([key, path]): Promise<[string, unknown]> => [
          key,
          (await jsonata(path).evaluate(child.context)) as unknown,
        ],
      ),
    ),
  );
}
