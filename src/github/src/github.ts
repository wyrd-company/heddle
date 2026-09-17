import type { Auth } from "./auth.js";
import { NameCache } from "./cache.js";
import type { Context } from "./context.js";
import { createOwner, type Owner } from "./owner/owner.js";
import type { IssueFieldSchema, NoIssueFields } from "./schema/types.js";
import { createExecute } from "./transport/execute.js";
import { OctokitTransport } from "./transport/octokit-transport.js";
import type { RestResponse, Transport } from "./transport/transport.js";

export interface GitHubOptions {
  auth: Auth;
  /** Replace the wire. Two adapters exist: Octokit (default) and Scripted (tests). */
  transport?: Transport;
  baseUrl?: string;
}

export interface GitHub {
  /** The only locator. Repos, projects, issues and pulls are reached through it. */
  owner<S extends IssueFieldSchema = NoIssueFields>(
    login: string,
    opts?: { issueFields?: S },
  ): Owner<S>;
  /** Escape hatch. Untyped at the public surface on purpose. */
  raw: {
    graphql(document: string, variables?: Record<string, unknown>): Promise<unknown>;
    rest(route: string, params?: Record<string, unknown>): Promise<RestResponse>;
  };
}

export function github(options: GitHubOptions): GitHub {
  const transport =
    options.transport ??
    new OctokitTransport(
      options.auth,
      options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl },
    );
  const ctx: Context = { transport, cache: new NameCache(), execute: createExecute(transport) };
  return {
    owner: (login, opts) => createOwner(ctx, login, opts?.issueFields),
    raw: {
      graphql: (document, variables = {}) =>
        transport.graphql({ name: "raw", document, variables }),
      rest: (route, params) => transport.rest(route, params),
    },
  };
}
