// ---
// relationships:
//   implements: heddle
// ---

import { isMap, parseDocument, type Document } from "yaml";

import { BoardStoreError } from "./errors.js";

/**
 * kanban-md writes its frontmatter with go-yaml, whose sequences indent by
 * four columns. Heddle matches that so a task file it rewrites keeps the shape
 * the rest of the board already has.
 */
const YAML_INDENT = 4;

export interface TaskDocument {
  /** The parsed frontmatter, retained so unowned properties survive a write. */
  frontMatter: Document;
  body: string;
}

/**
 * Splits a task file exactly the way kanban-md splits it: the file must open
 * with `---\n`, and the frontmatter ends at the first `\n---` that closes it.
 */
export const parseTaskFile = (source: string): TaskDocument => {
  if (!source.startsWith("---\n")) {
    throw new BoardStoreError(
      "invalid-task",
      "task file does not start with YAML frontmatter (---)",
    );
  }
  const rest = source.slice(4);
  let end = rest.indexOf("\n---\n");
  let closingLength = "\n---\n".length;
  if (end === -1) {
    if (rest.endsWith("\n---")) {
      end = rest.length - "---".length;
      closingLength = "---".length;
    } else {
      throw new BoardStoreError(
        "invalid-task",
        "task file has unclosed frontmatter (missing closing ---)",
      );
    }
  }

  const frontMatter = parseDocument(rest.slice(0, end));
  if (frontMatter.errors.length > 0) {
    throw new BoardStoreError(
      "invalid-task",
      `task frontmatter is invalid YAML: ${frontMatter.errors[0]!.message}`,
    );
  }
  if (!isMap(frontMatter.contents)) {
    throw new BoardStoreError(
      "invalid-task",
      "task frontmatter must be a YAML mapping",
    );
  }

  const bodyStart = end + closingLength;
  const body =
    bodyStart < rest.length ? rest.slice(bodyStart).replace(/^\n+/, "") : "";

  return { body, frontMatter };
};

/**
 * Renders a task file. Mutating the parsed document rather than re-encoding it
 * is what keeps properties kanban-md does not own — and Heddle does not own
 * either — in the file and in their original order.
 */
export const renderTaskFile = ({ body, frontMatter }: TaskDocument): string => {
  const serialized = frontMatter.toString({
    indent: YAML_INDENT,
    lineWidth: 0,
  });
  const normalized = serialized.endsWith("\n") ? serialized : `${serialized}\n`;
  const trailer =
    body === "" ? "" : `\n${body}${body.endsWith("\n") ? "" : "\n"}`;
  return `---\n${normalized}---\n${trailer}`;
};
