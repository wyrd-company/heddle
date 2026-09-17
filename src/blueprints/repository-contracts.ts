// ---
// relationships:
//   implements: blueprint-authoring
// ---
import { completionContractFindings } from "./completion-contracts.js";
import { declaredPath, schemaAtPath } from "./output-schemas.js";
import { validateBlueprintSchema } from "./schema-validation.js";
import type { LoadedBlueprint, ValidationFinding } from "./types.js";

/** Repository agreements are separate from the file-local check chain. */
export function repositoryContractFindings(
  inventory: readonly LoadedBlueprint[],
): ValidationFinding[] {
  const loaded = inventory.filter(
    (item) => validateBlueprintSchema(item.blueprint).valid,
  );
  const byId = new Map<string, LoadedBlueprint[]>();
  for (const item of loaded)
    byId.set(item.blueprint.id, [...(byId.get(item.blueprint.id) ?? []), item]);
  const findings = loaded.flatMap((item) =>
    completionContractFindings(item, byId),
  );
  for (const parent of loaded) {
    for (const [node, definition] of Object.entries(parent.blueprint.nodes)) {
      if (definition.uses !== "child-run") continue;
      const target = definition.params?.["blueprint"];
      if (typeof target !== "string") continue;
      const report = (rule: string, message: string) =>
        findings.push({
          file: parent.filePath,
          node,
          rule: `repository.${rule}`,
          message: `Blueprint ${parent.blueprint.id}, child-run ${node}, target ${target}: ${message}`,
        });
      const matches = byId.get(target) ?? [];
      if (matches.length === 0) {
        report("child-missing", "target is not in the loaded repository");
        continue;
      }
      if (matches.length > 1) {
        report(
          "child-duplicate",
          `target resolves to ${String(matches.length)} files`,
        );
        continue;
      }
      const child = matches[0]?.blueprint;
      if (child === undefined) continue;
      if (definition.stage === true && child.kind !== "stage")
        report(
          "child-kind",
          `target kind ${child.kind} is incompatible with this child-run`,
        );
      const declared = child.outputs ?? {};
      const mappings =
        definition.params?.["outputs"] ??
        Object.fromEntries(Object.keys(declared).map((key) => [key, key]));
      if (typeof mappings !== "object") continue;
      for (const [name, expression] of Object.entries(mappings)) {
        if (typeof expression !== "string") continue;
        const path = declaredPath(expression);
        const schema = path?.[0] === undefined ? undefined : declared[path[0]];
        if (
          path !== undefined &&
          (schema === undefined ||
            schemaAtPath(schema, path.slice(1)) === undefined)
        )
          report(
            "child-output-path",
            `mapping ${name}: ${expression} is not declared by the child's output contract`,
          );
        if (path?.[0] === "result") {
          for (const failure of findings.filter(
            (item) =>
              item.file === matches[0]?.filePath &&
              item.rule === "repository.output-shape",
          ))
            report(
              "child-output-shape",
              `mapping ${name}: ${expression} reads a terminal value incompatible with outputs.result at child node ${failure.node}`,
            );
        }
      }
    }
  }
  return findings;
}
