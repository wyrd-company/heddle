// ---
// relationships:
//   implements: command-line-interface
// ---
import { readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import jsonata from "jsonata";
import { parse } from "yaml";
import {
  deriveFlowcraftBlueprint,
  type HeddleFlowcraftBlueprint,
} from "../blueprints/flowcraft.js";
import { discoverBlueprintFiles } from "../blueprints/discovery.js";
import {
  loadValidatedBlueprint,
  validateBlueprintPath,
} from "../blueprints/validate.js";
import { resolveValues } from "../engine/runtime.js";
import type { EngineNode } from "../engine/types.js";
import type { Blueprint } from "../blueprints/types.js";

interface Entry {
  authored: Blueprint;
  blueprint: HeddleFlowcraftBlueprint;
  directory: string;
}

export class BlueprintCatalog {
  private readonly entries = new Map<string, Entry>();
  constructor(readonly root: string) {
    const findings = validateBlueprintPath(root);
    if (findings.length)
      throw new Error(
        `Blueprint repository is invalid: ${findings.map((item) => `${item.file}:${item.node} [${item.rule}] ${item.message}`).join("; ")}`,
      );
    for (const path of discoverBlueprintFiles(root)) {
      const loaded = loadValidatedBlueprint(path);
      this.entries.set(loaded.blueprint.id, {
        authored: loaded.blueprint,
        blueprint: deriveFlowcraftBlueprint(loaded.blueprint),
        directory: dirname(path),
      });
    }
  }
  list(): readonly Blueprint[] {
    return [...this.entries.values()].map((entry) => entry.authored);
  }
  resolve(_commit: string, id: string): Promise<HeddleFlowcraftBlueprint> {
    const entry = this.entries.get(id);
    if (!entry) return Promise.reject(new Error(`Unknown blueprint: ${id}`));
    return Promise.resolve(structuredClone(entry.blueprint));
  }
  read(_commit: string, id: string, path: string): Promise<string> {
    const entry = this.entries.get(id);
    if (!entry) return Promise.reject(new Error(`Unknown blueprint: ${id}`));
    const target = resolve(entry.directory, path);
    const displacement = relative(entry.directory, target);
    if (displacement === ".." || displacement.startsWith(`..${sep}`))
      return Promise.reject(
        new Error("Blueprint artifact path leaves its directory"),
      );
    return Promise.resolve(readFileSync(target, "utf8"));
  }
  readonly policyNode: EngineNode = async ({ run, params }) => {
    const source = await this.read(
      run.commit,
      run.blueprintId,
      String(params["rules"]),
    );
    const policy = parse(source) as {
      rules: {
        id: string;
        when?: string;
        blueprint: string;
        inputs?: Record<string, unknown>;
      }[];
    };
    const input = (params["input"] ?? {}) as Record<string, unknown>;
    for (const rule of policy.rules) {
      if (
        rule.when === undefined ||
        Boolean(await jsonata(rule.when).evaluate(input))
      )
        return {
          id: rule.id,
          blueprint: rule.blueprint,
          inputs: await resolveValues(rule.inputs ?? {}, input),
        };
    }
    throw new Error("No intake policy matched");
  };
}
