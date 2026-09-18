// ---
// relationships:
//   implements: node-types
// ---
import nunjucks from "nunjucks";
import { repositoryPath } from "../service/blueprint-repository.js";
import type { Data } from "../engine/types.js";

/** Blueprint root reads at one pinned commit. */
export interface TemplateSource {
  /** A path from the blueprint root. */
  read(commit: string, path: string): Promise<string>;
}

/** Where one authored template is rendered and what it may read. */
export interface TemplateSite {
  commit: string;
  blueprintId: string;
  /** Names the authored input in errors, such as `pass prompt`. */
  label: string;
  source?: TemplateSource | undefined;
}

function loaderFor(site: TemplateSite): nunjucks.ILoaderAsync {
  return {
    async: true,
    getSource(name, callback) {
      let identity: string;
      try {
        identity = repositoryPath(name);
      } catch (error) {
        callback(
          error instanceof Error ? error : new Error(String(error)),
          null,
        );
        return;
      }
      const source = site.source;
      if (!source) {
        callback(
          new Error(
            `${site.label} includes ${identity} but no blueprint root is configured`,
          ),
          null,
        );
        return;
      }
      source.read(site.commit, identity).then(
        (src) => {
          callback(null, { src, path: identity, noCache: true });
        },
        (error: unknown) => {
          callback(
            error instanceof Error ? error : new Error(String(error)),
            null,
          );
        },
      );
    },
  };
}

async function templateText(
  value: unknown,
  site: TemplateSite,
): Promise<string> {
  if (typeof value === "string") {
    if (!site.source)
      throw new Error(
        `${site.label} names a template path but no blueprint root is configured`,
      );
    return site.source.read(site.commit, value);
  }
  const inline =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Data)["inline"]
      : undefined;
  if (typeof inline !== "string")
    throw new Error(
      `${site.label} requires a pinned template path or inline text`,
    );
  return inline;
}

/**
 * Renders one `templateRef`: a path read from the run's pinned commit, or
 * inline text. Template and include paths alike resolve from the blueprint
 * root at that commit.
 */
export async function renderTemplate(
  value: unknown,
  context: Data,
  site: TemplateSite,
): Promise<string> {
  const text = await templateText(value, site);
  const environment = new nunjucks.Environment(loaderFor(site), {
    autoescape: false,
    throwOnUndefined: true,
  });
  return new Promise<string>((fulfil, reject) => {
    environment.renderString(text, context, (error, result) => {
      if (error) reject(error);
      else if (typeof result !== "string")
        reject(new Error(`${site.label} produced no text`));
      else fulfil(result);
    });
  });
}
