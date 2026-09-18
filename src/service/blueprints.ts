// ---
// relationships:
//   implements: command-line-interface
// ---
import { readFileSync, realpathSync } from "node:fs";
import { relative, sep } from "node:path";
import {
  BlueprintRepository,
  repositoryPath,
  safeIdentity,
} from "./blueprint-repository.js";
import { beside } from "../blueprints/root.js";
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
}

/** One pinned revision: its blueprints, and every file by root-relative path. */
interface Snapshot {
  entries: Map<string, Entry>;
  files: Map<string, string>;
}

export class BlueprintCatalog {
  private readonly snapshots = new Map<string, Promise<Snapshot>>();
  private readonly repository: BlueprintRepository;
  constructor(readonly root: string) {
    this.repository = new BlueprintRepository(root);
  }
  pin(revision: string): Promise<string> {
    return this.repository.pin(revision);
  }
  private snapshot(commit: string): Promise<Snapshot> {
    let snapshot = this.snapshots.get(commit);
    if (!snapshot) {
      snapshot = this.repository.tree(commit, (root, files) => {
        const findings = validateBlueprintPath(root);
        if (findings.length)
          throw new Error(
            `Invalid blueprint revision ${safeIdentity(commit)}: ${findings
              .map((item) => {
                const identity =
                  item.reference !== undefined
                    ? safeIdentity(item.reference)
                    : safeIdentity(relative(root, item.file));
                return `${identity} [${item.rule}] node ${safeIdentity(item.node)}`;
              })
              .join("; ")}`,
          );
        const contents = new Map<string, string>();
        for (const file of files) {
          try {
            if (beside(root, realpathSync(file)))
              contents.set(
                relative(root, file).split(sep).join("/"),
                readFileSync(file, "utf8"),
              );
          } catch {
            /* Dangling links are not repository files. */
          }
        }
        const entries = new Map<string, Entry>();
        for (const path of discoverBlueprintFiles(root)) {
          const loaded = loadValidatedBlueprint(path, { blueprintRoot: root });
          entries.set(loaded.blueprint.id, {
            authored: loaded.blueprint,
            blueprint: deriveFlowcraftBlueprint(loaded.blueprint),
          });
        }
        return { entries, files: contents };
      });
      this.snapshots.set(commit, snapshot);
      void snapshot.catch(() => this.snapshots.delete(commit));
    }
    return snapshot;
  }
  async list(revision = "HEAD"): Promise<readonly Blueprint[]> {
    const commit = await this.pin(revision);
    return structuredClone(
      [...(await this.snapshot(commit)).entries.values()].map(
        (entry) => entry.authored,
      ),
    );
  }
  private async entry(commit: string, id: string): Promise<Entry> {
    const entry = (await this.snapshot(commit)).entries.get(id);
    if (!entry)
      throw new Error(
        `Unknown blueprint ${safeIdentity(id)} at revision ${safeIdentity(commit)}`,
      );
    return entry;
  }
  async resolve(commit: string, id: string): Promise<HeddleFlowcraftBlueprint> {
    return structuredClone((await this.entry(commit, id)).blueprint);
  }
  /** A file addressed from the blueprint root at a pinned commit. */
  async read(commit: string, path: string): Promise<string> {
    const snapshot = await this.snapshot(commit);
    const contents = snapshot.files.get(repositoryPath(path));
    if (contents === undefined)
      throw new Error(
        `Missing blueprint root file ${safeIdentity(path)} at revision ${safeIdentity(commit)}`,
      );
    return contents;
  }
  readonly policyNode: EngineNode = async ({ run, params }) => {
    const source = await this.read(run.commit, String(params["rules"]));
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
          matched: true,
          id: rule.id,
          blueprint: rule.blueprint,
          inputs: await resolveValues(rule.inputs ?? {}, input),
        };
    }
    // No rule matched. The blueprint decides what an unmatched input means.
    return { matched: false };
  };
}
