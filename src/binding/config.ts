// ---
// relationships:
//   implements: github-binding-and-intake
// ---
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import {
  github,
  type GitHub,
  type GitHubOptions,
} from "../github/src/github.js";
import { OctokitTransport } from "../github/src/transport/octokit-transport.js";
import type { Transport } from "../github/src/transport/transport.js";

const credentials = z.object({
  "app-id": z.union([z.string().min(1), z.number().int().positive()]),
  installations: z.record(z.string(), z.number().int().positive()),
  "private-key": z.string().min(1),
});
export const bindingConfigSchema = z.object({
  projects: z
    .array(
      z.object({
        owner: z.string().min(1),
        number: z.number().int().positive(),
      }),
    )
    .min(1),
  github: z.object({ credentialFile: z.string().min(1) }),
  blueprints: z.object({ repository: z.string().min(1) }),
  t3Code: z.object({
    endpoint: z.string().min(1),
    tokenFile: z.string().optional(),
  }),
  webhook: z
    .object({
      secretFile: z.string(),
      listen: z
        .object({
          host: z.string().trim().min(1),
          port: z.number().int().min(1).max(65535),
        })
        .optional(),
    })
    .optional(),
});
export type BindingConfig = z.infer<typeof bindingConfigSchema>;
export type ProjectBinding = BindingConfig["projects"][number];
export interface RequestBudget {
  graphql: number;
  rest: number;
  mutations: number;
}
export type ClientFactory = (owner: string) => GitHub;
export interface AppClientOptions {
  wire?: (owner: string) => Transport;
  labelPageSize?: GitHubOptions["labelPageSize"];
  relationshipPageSize?: GitHubOptions["relationshipPageSize"];
}

/** Credentials are consumed in process; validation never prints their values. */
export function appClients(
  path: string,
  budget: RequestBudget,
  wireOrOptions?: ((owner: string) => Transport) | AppClientOptions,
): ClientFactory {
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Cannot parse Heddle GitHub App credential file");
  }
  const result = credentials.safeParse(raw);
  if (!result.success)
    throw new Error("Invalid Heddle GitHub App credential file");
  const auth = result.data;
  const options: AppClientOptions =
    typeof wireOrOptions === "function"
      ? { wire: wireOrOptions }
      : (wireOrOptions ?? {});
  return (owner) => {
    const installationId = auth.installations[owner];
    if (!installationId)
      throw new Error(`Heddle App has no configured installation for ${owner}`);
    const credential = {
      appId: auth["app-id"],
      privateKey: auth["private-key"],
      installationId,
    };
    const underlying =
      options.wire?.(owner) ?? new OctokitTransport(credential);
    const transport: Transport = {
      async graphql(operation) {
        budget.graphql++;
        if (/\bmutation\b/u.test(operation.document)) budget.mutations++;
        return underlying.graphql(operation);
      },
      async rest(route, params) {
        budget.rest++;
        if (!route.startsWith("GET ")) budget.mutations++;
        return underlying.rest(route, params);
      },
    };
    return github({
      auth: credential,
      transport,
      ...(options.labelPageSize === undefined
        ? {}
        : { labelPageSize: options.labelPageSize }),
      ...(options.relationshipPageSize === undefined
        ? {}
        : { relationshipPageSize: options.relationshipPageSize }),
    });
  };
}

export function loadBindingConfig(path: string): BindingConfig {
  return bindingConfigSchema.parse(parse(readFileSync(path, "utf8")));
}
