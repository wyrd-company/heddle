import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import { print, type DocumentNode, type OperationDefinitionNode } from "graphql";
import { ResponseShapeError } from "./errors.js";
import type { Transport } from "./transport.js";

/** Runs a typed document through a transport. The only place documents are executed. */
export type Execute = <TData, TVariables extends Record<string, unknown>>(
  document: TypedDocumentNode<TData, TVariables>,
  variables: TVariables,
) => Promise<TData>;

export function createExecute(transport: Transport): Execute {
  return async <TData, TVariables extends Record<string, unknown>>(
    document: TypedDocumentNode<TData, TVariables>,
    variables: TVariables,
  ): Promise<TData> => {
    const name = operationName(document);
    const data = await transport.graphql({ name, document: print(document), variables });
    if (data === null || data === undefined || typeof data !== "object") {
      throw new ResponseShapeError(name, "missing data");
    }
    return data as TData;
  };
}

export function operationName(document: DocumentNode): string {
  if (!Array.isArray(document.definitions)) {
    throw new Error(
      "GraphQL document is not registered in src/github/src/generated: its source text changed " +
        "after codegen ran. Run `task codegen`.",
    );
  }
  const op = document.definitions.find(
    (d): d is OperationDefinitionNode => d.kind === "OperationDefinition",
  );
  return op?.name?.value ?? "anonymous";
}

/** Narrowing helper for parse files: asserts a value is present or throws ResponseShapeError. */
export function required<T>(value: T | null | undefined, path: string): T {
  if (value === null || value === undefined) {
    throw new ResponseShapeError(path, "missing value");
  }
  return value;
}
