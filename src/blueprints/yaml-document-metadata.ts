// ---
// relationships:
//   implements: blueprint-authoring
// ---
import { CST, Parser, type Document } from "yaml";
import {
  applySourcePatches,
  parseSource,
  type SourcePatch,
} from "./yaml-source.js";

function documentDirectives(
  document: Document,
): NonNullable<Document["directives"]> {
  if (!document.directives)
    throw new Error("Cannot preserve YAML metadata without directives");
  return document.directives;
}

function customTagEntries(document: Document): readonly [string, string][] {
  return Object.entries(documentDirectives(document).tags).filter(
    ([handle, prefix]) => handle !== "!!" || prefix !== "tag:yaml.org,2002:",
  );
}

export function documentMetadataSnapshot(document: Document): unknown {
  const directives = documentDirectives(document);
  return {
    docStart:
      directives.docStart === true ||
      directives.yaml.explicit === true ||
      customTagEntries(document).length > 0,
    docEnd: directives.docEnd,
    yaml: directives.yaml,
    tags: Object.entries(directives.tags).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  };
}

interface DirectiveLine {
  readonly key: string;
  readonly value: string;
}

function directiveLine(token: CST.Directive): DirectiveLine | undefined {
  const yaml = /^%YAML[ \t]+(\S+)$/u.exec(token.source);
  const version = yaml?.[1];
  if (version) return { key: "YAML", value: version };
  const tag = /^%TAG[ \t]+(\S+)[ \t]+(\S+)$/u.exec(token.source);
  const handle = tag?.[1];
  const prefix = tag?.[2];
  return handle && prefix ? { key: `TAG ${handle}`, value: prefix } : undefined;
}

interface DesiredDirectiveLine {
  readonly source: string;
  readonly value: string;
}

function desiredDirectiveLines(
  document: Document,
): Map<string, DesiredDirectiveLine> {
  const result = new Map<string, DesiredDirectiveLine>();
  const directives = documentDirectives(document);
  if (directives.yaml.explicit)
    result.set("YAML", {
      source: `%YAML ${directives.yaml.version}`,
      value: directives.yaml.version,
    });
  for (const [handle, prefix] of customTagEntries(document))
    result.set(`TAG ${handle}`, {
      source: `%TAG ${handle} ${prefix}`,
      value: prefix,
    });
  return result;
}

function tokenEnd(token: CST.Token): number {
  return token.offset + ("source" in token ? token.source.length : 0);
}

function directiveRemovalEnd(
  tokens: readonly CST.Token[],
  index: number,
  directive: CST.Directive,
): number {
  let end = tokenEnd(directive);
  let cursor = index + 1;
  let next = tokens[cursor];
  while (next?.type === "space" && next.offset === end) {
    end = tokenEnd(next);
    cursor += 1;
    next = tokens[cursor];
  }
  return next?.type === "newline" && next.offset === end ? tokenEnd(next) : end;
}

function preludeInsertionOffset(
  tokens: readonly CST.Token[],
  document: CST.Document,
): number {
  let offset = tokens[0]?.offset ?? document.offset;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || token.offset >= document.offset) break;
    if (token.type !== "directive") continue;
    const following = tokens[index + 1];
    offset =
      following?.type === "newline" ? tokenEnd(following) : tokenEnd(token);
  }
  return offset;
}

function reconcileDirectiveLines(source: string, edited: Document): string {
  const tokens = [...new Parser().parse(source)];
  const document = tokens.find(
    (token): token is CST.Document => token.type === "document",
  );
  if (!document)
    throw new Error("Cannot preserve YAML directives without a document");
  const desired = desiredDirectiveLines(edited);
  const existing = tokens
    .map((token, index) => ({ token, index }))
    .filter(
      (entry): entry is { token: CST.Directive; index: number } =>
        entry.token.type === "directive",
    );
  const existingKeys = new Set<string>();
  const patches: SourcePatch[] = [];
  for (const { token, index } of existing) {
    const line = directiveLine(token);
    if (!line) continue;
    existingKeys.add(line.key);
    const target = desired.get(line.key);
    if (target === undefined) {
      patches.push({
        start: token.offset,
        end: directiveRemovalEnd(tokens, index, token),
        replacement: "",
      });
    } else if (target.value !== line.value) {
      patches.push({
        start: token.offset,
        end: tokenEnd(token),
        replacement: target.source,
      });
    }
  }

  const missing = [...desired].filter(([key]) => !existingKeys.has(key));
  if (missing.length > 0) {
    const newline = source.includes("\r\n") ? "\r\n" : "\n";
    if (existing.length === 0) {
      const start = preludeInsertionOffset(tokens, document);
      patches.push({
        start,
        end: start,
        replacement: missing.map(([, line]) => line.source + newline).join(""),
      });
      return applySourcePatches(source, patches);
    }
    const yaml = missing.filter(([key]) => key === "YAML");
    const tags = missing.filter(([key]) => key !== "YAML");
    if (yaml.length > 0) {
      const start =
        existing[0]?.token.offset ?? preludeInsertionOffset(tokens, document);
      patches.push({
        start,
        end: start,
        replacement: yaml.map(([, line]) => line.source + newline).join(""),
      });
    }
    if (tags.length > 0) {
      const last = existing.at(-1);
      const following = last ? tokens[last.index + 1] : undefined;
      const start = last
        ? following?.type === "newline"
          ? tokenEnd(following)
          : tokenEnd(last.token)
        : preludeInsertionOffset(tokens, document);
      patches.push({
        start,
        end: start,
        replacement: tags.map(([, line]) => line.source + newline).join(""),
      });
    }
  }
  return applySourcePatches(source, patches);
}

function removeMarkerPatch(
  marker: CST.SourceToken | CST.DocumentEnd,
  following: readonly CST.SourceToken[] | undefined,
): SourcePatch {
  let end = tokenEnd(marker);
  let next: CST.SourceToken | undefined;
  for (const token of following ?? []) {
    if (token.offset !== end) break;
    if (token.type === "space") {
      end = tokenEnd(token);
      continue;
    }
    next = token;
    break;
  }
  if (next?.type === "newline") end = tokenEnd(next);
  return { start: marker.offset, end, replacement: "" };
}

function reconcileDocumentMarkers(source: string, edited: Document): string {
  const tokens = [...new Parser().parse(source)];
  const document = tokens.find(
    (token): token is CST.Document => token.type === "document",
  );
  if (!document)
    throw new Error("Cannot preserve YAML markers without a document");
  const patches: SourcePatch[] = [];
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const start = document.start.find((token) => token.type === "doc-start");
  const directives = documentDirectives(edited);
  const needsStart =
    directives.docStart === true ||
    directives.yaml.explicit === true ||
    customTagEntries(edited).length > 0;
  if (needsStart && !start) {
    const offset = preludeInsertionOffset(tokens, document);
    patches.push({
      start: offset,
      end: offset,
      replacement: `---${newline}`,
    });
  }
  if (!needsStart && start)
    patches.push(
      removeMarkerPatch(
        start,
        document.start.slice(document.start.indexOf(start) + 1),
      ),
    );

  const endIndex = tokens.findIndex((token) => token.type === "doc-end");
  const end = endIndex >= 0 ? (tokens[endIndex] as CST.DocumentEnd) : undefined;
  if (directives.docEnd && !end) {
    const current = parseSource(source);
    const offset = current.contents?.range?.[2] ?? source.length;
    const separator =
      offset > 0 && source.slice(0, offset).endsWith(newline) ? "" : newline;
    patches.push({
      start: offset,
      end: offset,
      replacement: `${separator}...${newline}`,
    });
  }
  if (!directives.docEnd && end) patches.push(removeMarkerPatch(end, end.end));
  return applySourcePatches(source, patches);
}

export function reconcileDocumentMetadata(
  source: string,
  edited: Document,
): string {
  return reconcileDocumentMarkers(
    reconcileDirectiveLines(source, edited),
    edited,
  );
}
