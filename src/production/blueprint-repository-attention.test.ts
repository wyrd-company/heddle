// ---
// relationships:
//   verifies: heddle
// ---

import { describe, expect, it } from "vitest";

import {
  createConsoleAttention,
  validateConsoleAttentionCatalog,
  MAXIMUM_CONSOLE_ATTENTION_IDENTIFIER_LENGTH,
} from "../console/index.js";
import {
  blueprintRepositoryStateAttention,
  type BlueprintRepositoryState,
} from "./blueprint-repository.js";

const repositoryRoot = "/var/lib/example/organization-blueprints";

const codes = [
  "blueprint-repository-behind",
  "blueprint-repository-diverged",
  "blueprint-repository-dirty",
  "blueprint-repository-unpushed",
] as const satisfies ReadonlyArray<BlueprintRepositoryState["code"]>;

const identities = {
  sha1: { local: "a".repeat(40), upstream: "b".repeat(40) },
  sha256: { local: "c".repeat(64), upstream: "d".repeat(64) },
};

const state = (
  code: BlueprintRepositoryState["code"],
  commits: { local: string; upstream: string },
): BlueprintRepositoryState => ({
  code,
  localCommit: commits.local,
  message: "The organization blueprint repository is not synchronized",
  upstreamCommit: commits.upstream,
});

describe("blueprint repository state attention identity", () => {
  it.each(Object.entries(identities))(
    "passes the console attention catalog for every state code on a %s repository",
    (_algorithm, commits) => {
      const catalog = codes.map((code) =>
        createConsoleAttention({
          actions: [],
          attentionId: blueprintRepositoryStateAttention(
            repositoryRoot,
            state(code, commits),
          ).attentionId,
          kind: "blueprint-repository",
          message: "The organization blueprint repository needs attention",
          scope: "all",
        }),
      );

      expect(() =>
        validateConsoleAttentionCatalog(catalog, false),
      ).not.toThrow();
      for (const entry of catalog) {
        expect(entry.attentionId.length).toBeLessThanOrEqual(
          MAXIMUM_CONSOLE_ATTENTION_IDENTIFIER_LENGTH,
        );
      }
    },
  );

  it("names the local and origin commits on the attention payload", () => {
    const attention = blueprintRepositoryStateAttention(
      repositoryRoot,
      state("blueprint-repository-diverged", identities.sha1),
    );

    expect(attention).toMatchObject({
      localCommit: identities.sha1.local,
      upstreamCommit: identities.sha1.upstream,
    });
    expect(attention.message).toContain(identities.sha1.local);
    expect(attention.message).toContain(identities.sha1.upstream);
  });

  it("repeats one identity for an unchanged condition and separates every changed one", () => {
    const unchanged = state("blueprint-repository-dirty", identities.sha1);

    expect(
      blueprintRepositoryStateAttention(repositoryRoot, unchanged).attentionId,
    ).toBe(
      blueprintRepositoryStateAttention(repositoryRoot, unchanged).attentionId,
    );
    const varied = [
      unchanged,
      state("blueprint-repository-behind", identities.sha1),
      {
        ...unchanged,
        localCommit: identities.sha1.upstream,
      },
      {
        ...unchanged,
        upstreamCommit: identities.sha1.local,
      },
      state("blueprint-repository-dirty", identities.sha256),
    ];
    expect(
      new Set(
        varied.map(
          (entry) =>
            blueprintRepositoryStateAttention(repositoryRoot, entry)
              .attentionId,
        ),
      ).size,
    ).toBe(varied.length);
  });
});
