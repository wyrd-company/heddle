/**
 * The only injectable seam. Two adapters exist: OctokitTransport for
 * production and ScriptedTransport for tests.
 */
export interface GraphqlOperation {
  /** Operation name from the document. Scripted transports key on it. */
  name: string;
  document: string;
  variables: Record<string, unknown>;
}

export interface RestResponse {
  status: number;
  data: unknown;
  headers: Record<string, string>;
}

export interface Transport {
  /** Resolves to the `data` object. Any `errors[]` becomes one thrown GitHubError. */
  graphql(op: GraphqlOperation): Promise<unknown>;
  /** `route` is an Octokit route string such as `GET /repos/{owner}/{repo}/milestones`. */
  rest(route: string, params?: Record<string, unknown>): Promise<RestResponse>;
}
