// ---
// relationships:
//   verifies: heddle
// ---

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const featureDirectory = ".devcontainer/features/heddle";
const publishedReference = "ghcr.io/wyrd-company/heddle/heddle:1";

describe("Heddle devcontainer feature publication", () => {
  it("stages the tracked Heddle source without a pre-packaged release", async () => {
    const directory = await mkdtemp(join(tmpdir(), "heddle-feature-stage-"));
    const collection = join(directory, "features");

    try {
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
      const packageManifest = JSON.parse(
        await readFile(
          join(stagedFeature, "heddle-source/package.json"),
          "utf8",
        ),
      ) as { name: string; private: boolean; version: string };

      expect(manifest).toMatchObject({ id: "heddle", version: "1.0.0" });
      expect(packageManifest).toMatchObject({
        name: "heddle",
        private: true,
        version: manifest.version,
      });
      await expect(
        readFile(join(stagedFeature, "heddle-1.0.0.tgz")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        readFile(
          join(
            stagedFeature,
            "heddle-source/spikes/flowcraft-gate/viewer/vendor/flowcraft-tldraw/runtime/ExecutionBridge.tsx",
          ),
          "utf8",
        ),
      ).resolves.toContain("ExecutionBridge");
      await expect(
        readFile(
          join(
            stagedFeature,
            "heddle-source/spikes/flowcraft-gate/viewer/vendor/flowcraft-tldraw/shapes/types.ts",
          ),
          "utf8",
        ),
      ).resolves.toContain("FlowcraftNodeShape");
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
    const collection = join(directory, "features");

    try {
      await execute("bash", [
        "scripts/deployment/stage-feature.sh",
        collection,
      ]);
      const stagedFeature = join(collection, "heddle");
      await writeFile(join(stagedFeature, "heddle-stale.tgz"), "not a package");

      await expect(
        execute(join(stagedFeature, "verify-feature-source.sh"), [
          stagedFeature,
        ]),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining(
          "Pre-packaged Heddle tarballs are not a supported Feature source.",
        ),
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects a staged source whose version differs from the Feature", async () => {
    const directory = await mkdtemp(join(tmpdir(), "heddle-feature-version-"));
    const collection = join(directory, "features");

    try {
      await execute("bash", [
        "scripts/deployment/stage-feature.sh",
        collection,
      ]);
      const stagedFeature = join(collection, "heddle");
      const sourceManifest = join(stagedFeature, "heddle-source/package.json");
      const source = JSON.parse(
        await readFile(sourceManifest, "utf8"),
      ) as Record<string, unknown>;
      source.version = "1.0.1";
      await writeFile(sourceManifest, `${JSON.stringify(source)}\n`);

      await expect(
        execute(join(stagedFeature, "verify-feature-source.sh"), [
          stagedFeature,
        ]),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining(
          "The Feature and Heddle source identities do not agree.",
        ),
      });
    } finally {
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
      version: "1.0.0",
    });
    expect(configuration.features).toHaveProperty(publishedReference);
    expect(configuration.features).not.toHaveProperty("../features/heddle");
    expect(readme).toContain(`"${publishedReference}"`);
    expect(operatorGuide).toContain(`\`${publishedReference}\``);
  });

  it("publishes only after main CI success or a manual dispatch", async () => {
    const workflow = parse(
      await readFile(".github/workflows/cd.yml", "utf8"),
    ) as {
      jobs: Record<
        string,
        {
          permissions: Record<string, string>;
          steps: Array<{
            uses?: string;
            with?: Record<string, string>;
          }>;
        }
      >;
      on: {
        workflow_dispatch: unknown;
        workflow_run: {
          branches: string[];
          types: string[];
          workflows: string[];
        };
      };
      permissions: Record<string, never>;
    };

    expect(workflow.permissions).toEqual({});
    expect(workflow.on.workflow_dispatch).toBeDefined();
    expect(workflow.on.workflow_run).toEqual({
      branches: ["main"],
      types: ["completed"],
      workflows: ["CI"],
    });

    const publish = workflow.jobs["publish-features"];
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

    const ci = parse(await readFile(".github/workflows/ci.yml", "utf8")) as {
      on: { pull_request: unknown; push: { branches: string[] } };
      permissions: Record<string, never>;
    };
    expect(ci.permissions).toEqual({});
    expect(ci.on.pull_request).toBeNull();
    expect(ci.on.push.branches).toEqual(["main"]);
  });
});
