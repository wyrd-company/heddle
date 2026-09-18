// ---
// relationships:
//   implements: command-line-interface
// ---
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  BlueprintRepository,
  beside,
  safeIdentity,
} from "./blueprint-repository.js";
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
  artifacts: Map<string, string>;
}

export class BlueprintCatalog {
  private readonly snapshots = new Map<string, Promise<Map<string, Entry>>>();
  private readonly repository: BlueprintRepository;
  constructor(readonly root: string) {
    this.repository = new BlueprintRepository(root);
  }
  pin(revision: string): Promise<string> {
    return this.repository.pin(revision);
  }
  private snapshot(commit: string): Promise<Map<string, Entry>> {
    let snapshot = this.snapshots.get(commit);
    if (!snapshot) {
      snapshot = this.repository.tree(commit, (root, files) => {
        const findings = validateBlueprintPath(root);
        if (findings.length)
          throw new Error(
            `Invalid blueprint revision ${safeIdentity(commit)}: ${findings
              .map((item) => {
                const identity =
                  item.rule === "reference.exists"
                    ? safeIdentity(item.message.split(": ").at(-1) ?? "")
                    : safeIdentity(relative(root, item.file));
                return `${identity} [${item.rule}] node ${safeIdentity(item.node)}`;
              })
              .join("; ")}`,
          );
        const entries = new Map<string, Entry>();
        for (const path of discoverBlueprintFiles(root)) {
          const loaded = loadValidatedBlueprint(path);
          const directory = dirname(path);
          const artifacts = new Map<string, string>();
          for (const file of files) {
            if (!beside(directory, file)) continue;
            try {
              if (beside(directory, realpathSync(file)))
                artifacts.set(
                  relative(directory, file),
                  readFileSync(file, "utf8"),
                );
            } catch {
              /* Unreferenced dangling links are not artifacts. */
            }
          }
          entries.set(loaded.blueprint.id, {
            authored: loaded.blueprint,
            blueprint: deriveFlowcraftBlueprint(loaded.blueprint),
            artifacts,
          });
        }
        return entries;
      });
      this.snapshots.set(commit, snapshot);
      void snapshot.catch(() => this.snapshots.delete(commit));
    }
    return snapshot;
  }
  async list(revision = "HEAD"): Promise<readonly Blueprint[]> {
    const commit = await this.pin(revision);
    return structuredClone(
      [...(await this.snapshot(commit)).values()].map(
        (entry) => entry.authored,
      ),
    );
  }
  private async entry(commit: string, id: string): Promise<Entry> {
    const entry = (await this.snapshot(commit)).get(id);
    if (!entry)
      throw new Error(
        `Unknown blueprint ${safeIdentity(id)} at revision ${safeIdentity(commit)}`,
      );
    return entry;
  }
  async resolve(commit: string, id: string): Promise<HeddleFlowcraftBlueprint> {
    return structuredClone((await this.entry(commit, id)).blueprint);
  }
  async read(commit: string, id: string, path: string): Promise<string> {
    const entry = await this.entry(commit, id);
    const base = resolve("/blueprint");
    const target = resolve(base, path);
    if (isAbsolute(path) || !beside(base, target))
      throw new Error(
        `Invalid artifact identity at revision ${safeIdentity(commit)} for blueprint ${safeIdentity(id)}`,
      );
    const contents = entry.artifacts.get(relative(base, target));
    if (contents === undefined)
      throw new Error(
        `Missing blueprint artifact ${safeIdentity(path)} at revision ${safeIdentity(commit)} for blueprint ${safeIdentity(id)}`,
      );
    return contents;
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
