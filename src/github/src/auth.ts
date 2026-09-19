import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/core";
import { GitHubError } from "./transport/errors.js";

export type Auth =
  | { token: string }
  | { appId: string | number; privateKey: string; installationId: number }
  | { appId: string | number; privateKey: string; owner: string };

export interface OctokitFactoryOptions {
  baseUrl?: string;
}

/**
 * Builds the Octokit instance for an Auth value. App credentials with an
 * owner login resolve the installation id once, through the app JWT.
 */
export async function createOctokit(auth: Auth, options: OctokitFactoryOptions): Promise<Octokit> {
  const base = options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl };
  if ("token" in auth) {
    // Octokit's default strategy is createTokenAuth when `auth` is a string.
    return new Octokit({ ...base, auth: auth.token });
  }
  const installationId =
    "installationId" in auth ? auth.installationId : await resolveInstallationId(auth, base);
  return new Octokit({
    ...base,
    authStrategy: createAppAuth,
    auth: { appId: auth.appId, privateKey: auth.privateKey, installationId },
  });
}

async function resolveInstallationId(
  auth: { appId: string | number; privateKey: string; owner: string },
  base: OctokitFactoryOptions,
): Promise<number> {
  const app = new Octokit({
    ...base,
    authStrategy: createAppAuth,
    auth: { appId: auth.appId, privateKey: auth.privateKey },
  });
  const lookups = [
    () => app.request("GET /orgs/{org}/installation", { org: auth.owner }),
    () => app.request("GET /users/{username}/installation", { username: auth.owner }),
  ];
  let lastError: unknown;
  for (const lookup of lookups) {
    try {
      const response = await lookup();
      return response.data.id;
    } catch (error) {
      lastError = error;
      if (!isNotFound(error)) break;
    }
  }
  throw new GitHubError("NOT_FOUND", `no app installation for owner ${auth.owner}`, {
    cause: lastError,
  });
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { status?: number }).status === 404
  );
}
