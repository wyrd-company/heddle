import { GitHubError } from "../transport/errors.js";
import type { GraphqlOperation, RestResponse, Transport } from "../transport/transport.js";

export type GraphqlResponder = (variables: Record<string, unknown>) => unknown;
export type RestResponder = (params: Record<string, unknown>) => RestResponse | unknown;

export interface Script {
  /** Keyed by operation name. An array answers successive calls in order. */
  graphql?: Record<string, GraphqlResponder | GraphqlResponder[]>;
  /** Keyed by route string such as `GET /repos/{owner}/{repo}/milestones`. */
  rest?: Record<string, RestResponder | RestResponder[]>;
}

export interface RecordedCall {
  kind: "graphql" | "rest";
  name: string;
  input: Record<string, unknown>;
}

/**
 * Test adapter. Answers each operation from the script and records every
 * call. Throws a GitHubError (UNSUPPORTED) for anything unscripted so a
 * missing script line fails loudly instead of returning undefined.
 */
export class ScriptedTransport implements Transport {
  readonly calls: RecordedCall[] = [];
  readonly #graphql = new Map<string, GraphqlResponder[]>();
  readonly #rest = new Map<string, RestResponder[]>();

  constructor(script: Script = {}) {
    for (const [name, responder] of Object.entries(script.graphql ?? {})) {
      this.#graphql.set(name, Array.isArray(responder) ? [...responder] : [responder]);
    }
    for (const [route, responder] of Object.entries(script.rest ?? {})) {
      this.#rest.set(route, Array.isArray(responder) ? [...responder] : [responder]);
    }
  }

  async graphql(op: GraphqlOperation): Promise<unknown> {
    this.calls.push({ kind: "graphql", name: op.name, input: op.variables });
    const responder = take(this.#graphql.get(op.name));
    if (!responder)
      throw new GitHubError("UNSUPPORTED", `unscripted graphql operation: ${op.name}`);
    return responder(op.variables);
  }

  async rest(route: string, params: Record<string, unknown> = {}): Promise<RestResponse> {
    this.calls.push({ kind: "rest", name: route, input: params });
    const responder = take(this.#rest.get(route));
    if (!responder) throw new GitHubError("UNSUPPORTED", `unscripted rest route: ${route}`);
    const result = responder(params);
    return isRestResponse(result) ? result : { status: 200, data: result, headers: {} };
  }

  /** Calls made to one operation or route, in order. */
  callsTo(name: string): RecordedCall[] {
    return this.calls.filter((c) => c.name === name);
  }
}

/** Takes the next responder; the last one keeps answering. */
function take<T>(responders: T[] | undefined): T | undefined {
  if (!responders || responders.length === 0) return undefined;
  return responders.length > 1 ? responders.shift() : responders[0];
}

function isRestResponse(value: unknown): value is RestResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as RestResponse).status === "number" &&
    "data" in value
  );
}
