// ---
// relationships:
//   verifies: heddle
// ---

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const featureDirectory = ".devcontainer/features/heddle";
const publishedReference = "ghcr.io/wyrd-company/heddle/heddle:0";

// The Feature's own manifest is its version authority, so assertions follow a
// release instead of pinning the version a release moves.
const featureVersion = (
  JSON.parse(
    readFileSync(`${featureDirectory}/devcontainer-feature.json`, "utf8"),
  ) as { version: string }
).version;

describe("Heddle devcontainer feature publication", () => {
  it("assigns package and Feature versions to independent release units", async () => {
    const config = parse(await readFile(".intentional/config.yml", "utf8")) as {
      discovery: {
        "managed-paths": Array<Record<string, string>>;
      };
      "release-units": Record<
        string,
        {
          path: string;
          projections: Array<Record<string, string>>;
          tags: { primary: Record<string, string> };
        }
      >;
      settings: { "pre-1-0-bump-mapping": string };
    };

    expect(config.settings["pre-1-0-bump-mapping"]).toBe("component");
    expect(config.discovery["managed-paths"]).toEqual(
      expect.arrayContaining([
        {
          detector: "npm-package",
          path: "package.json",
          "release-unit": "heddle",
        },
        {
          detector: "devcontainer-feature",
          path: ".devcontainer/features/heddle/devcontainer-feature.json",
          "release-unit": "heddle-feature",
        },
      ]),
    );
    expect(config["release-units"].heddle?.projections).toEqual([
      { adapter: "npm", file: "package.json", mode: "committed" },
    ]);
    expect(config["release-units"]["heddle-feature"]?.path).toBe(
      ".devcontainer/features/heddle",
    );
    expect(config["release-units"]["heddle-feature"]?.projections).toEqual([
      {
        adapter: "json",
        file: "devcontainer-feature.json",
        mode: "committed",
        pointer: "/version",
      },
    ]);
    expect(config["release-units"].heddle?.tags.primary.template).toBe(
      "{id}@{version}",
    );
    expect(
      config["release-units"]["heddle-feature"]?.tags.primary.template,
    ).toBe("{id}@{version}");
  });

  it("keeps viewer libraries out of the eight runtime dependencies", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      private: boolean;
    };

    expect(manifest.private).toBe(true);
    expect(Object.keys(manifest.dependencies).sort()).toEqual([
      "@flowcraft/sqlite-history",
      "@modelcontextprotocol/server",
      "ajv",
      "better-sqlite3",
      "flowcraft",
      "nunjucks",
      "yaml",
      "zod",
    ]);
    expect(manifest.devDependencies).toMatchObject({
      "@tldraw/validate": "5.3.2",
      react: expect.any(String),
      "react-dom": expect.any(String),
      tldraw: expect.any(String),
    });
  });

  it("stages only the tracked Feature without Heddle source or a package", async () => {
    const directory = await mkdtemp(join(tmpdir(), "heddle-feature-stage-"));
    const collection = join(directory, "features");

    try {
      await mkdir(collection);
      await writeFile(join(collection, "sibling-feature"), "preserve me");
      await execute("bash", [
        "scripts/deployment/stage-feature.sh",
        collection,
      ]);

      const stagedFeature = join(collection, "heddle");
      const manifest = JSON.parse(
        await readFile(
          join(stagedFeature, "devcontainer-feature.json"),
          "utf8",
        ),
      ) as { id: string; version: string };
      expect(manifest).toMatchObject({ id: "heddle", version: featureVersion });
      await expect(
        readFile(join(collection, "sibling-feature"), "utf8"),
      ).resolves.toBe("preserve me");
      await expect(
        readFile(join(stagedFeature, "heddle-1.0.0.tgz")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        readFile(join(stagedFeature, "heddle-source/package.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        readFile(join(stagedFeature, "resolve-package-source.mjs"), "utf8"),
      ).resolves.toContain("heddle@*");
      await expect(
        execute(join(stagedFeature, "verify-feature-source.sh"), [
          stagedFeature,
        ]),
      ).resolves.toMatchObject({ stderr: "" });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects a pre-placed Heddle tarball", async () => {
    const directory = await mkdtemp(join(tmpdir(), "heddle-feature-legacy-"));
    const fixtureFeature = join(directory, "heddle");

    try {
      await cp(featureDirectory, fixtureFeature, { recursive: true });
      await writeFile(
        join(fixtureFeature, "heddle-stale.tgz"),
        "not a package",
      );

      await expect(
        execute(join(featureDirectory, "verify-feature-source.sh"), [
          fixtureFeature,
        ]),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining(
          "The published Feature must not contain a Heddle package tarball.",
        ),
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects a staged Heddle source tree", async () => {
    const directory = await mkdtemp(join(tmpdir(), "heddle-feature-source-"));
    const fixtureFeature = join(directory, "heddle");

    try {
      await cp(featureDirectory, fixtureFeature, { recursive: true });
      await mkdir(join(fixtureFeature, "heddle-source"));

      await expect(
        execute(join(featureDirectory, "verify-feature-source.sh"), [
          fixtureFeature,
        ]),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining(
          "The published Feature must not contain a Heddle source tree.",
        ),
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("stages only files from the accepted tracked publishing head", async () => {
    const directory = await mkdtemp(join(tmpdir(), "feature-source-head-"));
    const collection = join(directory, "features");
    const fixtureIdentity = randomUUID();
    const untrackedFixture = join(
      "src",
      `staging-untracked-${fixtureIdentity}.ts`,
    );
    const ignoredFixture = join(
      "src",
      `staging-ignored-${fixtureIdentity}.log`,
    );
    const featureIgnoredFixture = join(
      featureDirectory,
      `staging-ignored-${fixtureIdentity}.log`,
    );

    try {
      await writeFile(untrackedFixture, "export const fixture = true;\n");
      await writeFile(ignoredFixture, "ignored fixture\n");
      await writeFile(featureIgnoredFixture, "ignored feature fixture\n");
      await expect(
        execute("git", ["ls-files", "--error-unmatch", untrackedFixture]),
      ).rejects.toMatchObject({ code: 1 });
      await expect(
        execute("git", ["check-ignore", "--quiet", ignoredFixture]),
      ).resolves.toMatchObject({ stderr: "", stdout: "" });
      await expect(
        execute("git", ["check-ignore", "--quiet", featureIgnoredFixture]),
      ).resolves.toMatchObject({ stderr: "", stdout: "" });

      await execute("bash", [
        "scripts/deployment/stage-feature.sh",
        collection,
      ]);

      await expect(
        readFile(join(collection, "heddle", "heddle-source", untrackedFixture)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        readFile(join(collection, "heddle", "heddle-source", ignoredFixture)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        readFile(join(collection, "heddle", basename(featureIgnoredFixture))),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(untrackedFixture, { force: true });
      await rm(ignoredFixture, { force: true });
      await rm(featureIgnoredFixture, { force: true });
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("refuses to replace the checked-in Feature collection", async () => {
    await expect(
      execute("bash", [
        "scripts/deployment/stage-feature.sh",
        ".devcontainer/features",
      ]),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Refusing to replace source directory"),
    });
  });

  it("binds the manifest, clean-container config, and documentation to one remote reference", async () => {
    const manifest = JSON.parse(
      await readFile(`${featureDirectory}/devcontainer-feature.json`, "utf8"),
    ) as { documentationURL: string; id: string; version: string };
    const configuration = JSON.parse(
      await readFile(".devcontainer/qualification/devcontainer.json", "utf8"),
    ) as { features: Record<string, unknown> };
    const readme = await readFile(`${featureDirectory}/README.md`, "utf8");
    const operatorGuide = await readFile(
      "docs/operators/production-composition.md",
      "utf8",
    );

    expect(manifest).toMatchObject({
      documentationURL:
        "https://github.com/wyrd-company/heddle/tree/main/.devcontainer/features/heddle",
      id: "heddle",
      version: featureVersion,
    });
    expect(configuration.features).toHaveProperty(publishedReference);
    expect(configuration.features).not.toHaveProperty("../features/heddle");
    expect(readme).toContain(`"${publishedReference}"`);
    expect(operatorGuide).toContain(`\`${publishedReference}\``);
  });

  it("publishes each release unit only from its own tag namespace", async () => {
    const workflow = parse(
      await readFile(".github/workflows/cd.yml", "utf8"),
    ) as {
      jobs: Record<
        string,
        {
          if: string;
          permissions: Record<string, string>;
          steps: Array<{
            run?: string;
            uses?: string;
            with?: Record<string, string>;
          }>;
        }
      >;
      on: {
        push: { tags: string[] };
        workflow_dispatch: unknown;
        workflow_run?: unknown;
      };
      permissions: Record<string, never>;
    };

    expect(workflow.permissions).toEqual({});
    expect(workflow.on.workflow_dispatch).toBeDefined();
    expect(workflow.on.workflow_run).toBeUndefined();
    expect(workflow.on.push.tags).toEqual(["heddle@*", "heddle-feature@*"]);

    const publish = workflow.jobs["publish-features"];
    expect(publish?.if).toContain("github.event_name == 'push'");
    expect(publish?.if).toContain("refs/tags/heddle-feature@");
    expect(publish?.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(publish?.if).toContain("github.ref == 'refs/heads/main'");
    expect(publish?.if).not.toContain("workflow_run");
    expect(publish?.if).not.toContain("refs/tags/heddle@'");
    expect(publish?.permissions).toMatchObject({
      contents: "write",
      packages: "write",
      "pull-requests": "write",
    });
    expect(publish?.steps).toContainEqual(
      expect.objectContaining({
        uses: "devcontainers/action@1082abd5d2bf3a11abccba70eef98df068277772",
        with: expect.objectContaining({
          "base-path-to-features": "./.devcontainer/publish/features",
          "devcontainer-cli-version": "0.88.0",
          "publish-features": "true",
        }),
      }),
    );

    const packageAsset = workflow.jobs["publish-package-asset"];
    expect(packageAsset?.if).toContain("refs/tags/heddle@");
    expect(packageAsset?.if).not.toContain("heddle-feature@");
    expect(packageAsset?.permissions).toEqual({ contents: "write" });
    expect(packageAsset?.steps).toContainEqual(
      expect.objectContaining({ run: "npm run build" }),
    );

    const pushGuard = (condition: string | undefined) => {
      const namespaces = [
        ...(condition ?? "").matchAll(/startsWith\(github\.ref, '([^']+)'\)/g),
      ].map((match) => match[1]);
      const exclusions = [
        ...(condition ?? "").matchAll(/github\.ref != '([^']+)'/g),
      ].map((match) => match[1]);
      expect(namespaces).toHaveLength(1);
      expect(exclusions).toHaveLength(1);
      return (reference: string) =>
        reference.startsWith(namespaces[0] ?? "") &&
        reference !== exclusions[0];
    };
    const publishesPackageAsset = pushGuard(packageAsset?.if);
    const publishesFeature = pushGuard(publish?.if);

    expect([
      {
        asset: publishesPackageAsset("refs/tags/heddle@0.0.0"),
        feature: publishesFeature("refs/tags/heddle@0.0.0"),
      },
      {
        asset: publishesPackageAsset("refs/tags/heddle-feature@0.0.0"),
        feature: publishesFeature("refs/tags/heddle-feature@0.0.0"),
      },
      {
        asset: publishesPackageAsset("refs/tags/heddle@0.1.0"),
        feature: publishesFeature("refs/tags/heddle@0.1.0"),
      },
      {
        asset: publishesPackageAsset("refs/tags/heddle-feature@0.1.0"),
        feature: publishesFeature("refs/tags/heddle-feature@0.1.0"),
      },
    ]).toEqual([
      { asset: false, feature: false },
      { asset: false, feature: false },
      { asset: true, feature: false },
      { asset: false, feature: true },
    ]);
    expect(packageAsset?.steps).toContainEqual(
      expect.objectContaining({
        run: expect.stringContaining('gh release upload "${GITHUB_REF_NAME}"'),
      }),
    );
    expect(await readFile(".github/workflows/cd.yml", "utf8")).not.toContain(
      "npm publish",
    );

    const ci = parse(await readFile(".github/workflows/ci.yml", "utf8")) as {
      on: { pull_request: unknown; push: { branches: string[] } };
      permissions: Record<string, never>;
    };
    expect(ci.permissions).toEqual({});
    expect(ci.on.pull_request).toBeNull();
    expect(ci.on.push.branches).toEqual(["main"]);
  });
});
