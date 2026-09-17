// ---
// relationships:
//   implements:
//     - blueprint-authoring
//     - node-types
// ---
import type { Document } from "yaml";

export type JsonObject = Record<string, unknown>;

export interface BlueprintNode {
  readonly uses: string;
  readonly description?: string;
  readonly stage?: boolean;
  readonly metadata?: JsonObject;
  readonly fixed?: readonly string[];
  readonly params?: JsonObject;
  readonly inputs?: string | Readonly<Record<string, string>>;
  readonly config?: {
    readonly joinStrategy?: "all" | "any";
    readonly maxRetries?: number;
    readonly retryDelay?: number;
  };
}

export interface BlueprintEdge {
  readonly from: string;
  readonly to: string;
  readonly when?: string;
  readonly description?: string;
  readonly [key: string]: unknown;
}

export interface Blueprint {
  readonly id: string;
  readonly entry?: string;
  readonly kind: "process" | "stage" | "helper";
  readonly description?: string;
  readonly metadata?: JsonObject;
  readonly requires?: JsonObject;
  readonly inputs?: Readonly<Record<string, JsonObject>>;
  readonly outputs?: Readonly<Record<string, JsonObject>>;
  readonly nodes: Readonly<Record<string, BlueprintNode>>;
  readonly edges?: readonly BlueprintEdge[];
}

export interface LoadedBlueprint {
  readonly filePath: string;
  readonly source: string;
  readonly document: Document;
  readonly blueprint: Blueprint;
  readonly originalValue: unknown;
}

export interface ValidationFinding {
  readonly file: string;
  readonly node: string;
  readonly rule: string;
  readonly message: string;
}

export interface ValidationOptions {
  readonly checkRequiresIssue?: boolean;
  readonly configuredQuestionRoles?: ReadonlySet<string>;
}

export interface BlueprintCheckResult {
  readonly findings: readonly ValidationFinding[];
  readonly loaded?: LoadedBlueprint;
}
