import { readFileSync } from "node:fs";
import type { Auth } from "../auth.js";

/**
 * Credentials for the live suites, from the environment.
 *
 * - `owner`: organization and project administration. `GITHUB_TOKEN`.
 * - `repo`: issues, pull requests, labels, milestones. A GitHub App when
 *   `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH` and `GITHUB_APP_INSTALLATION_ID`
 *   are set, else `GITHUB_REPO_TOKEN`, else `GITHUB_TOKEN`.
 *
 * One token with every permission satisfies both scopes.
 */
export function liveAuth(scope: "owner" | "repo"): Auth | undefined {
  const env = process.env;
  if (scope === "repo") {
    if (
      env["GITHUB_APP_ID"] &&
      env["GITHUB_APP_PRIVATE_KEY_PATH"] &&
      env["GITHUB_APP_INSTALLATION_ID"]
    ) {
      return {
        appId: env["GITHUB_APP_ID"],
        privateKey: readFileSync(env["GITHUB_APP_PRIVATE_KEY_PATH"], "utf8"),
        installationId: Number(env["GITHUB_APP_INSTALLATION_ID"]),
      };
    }
    if (env["GITHUB_REPO_TOKEN"]) return { token: env["GITHUB_REPO_TOKEN"] };
  }
  return env["GITHUB_TOKEN"] ? { token: env["GITHUB_TOKEN"] } : undefined;
}

export const liveOwner = process.env["GITHUB_TEST_OWNER"];
export const liveRepo = process.env["GITHUB_TEST_REPO"];
