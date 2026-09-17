// ---
// relationships:
//   verifies:
//     - engine-and-run-model
//     - github-binding-and-intake
// ---
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const manifestPath = new URL(
  "../features/heddle/devcontainer-feature.json",
  import.meta.url,
);
const installerPath = new URL("../features/heddle/install.sh", import.meta.url);
const buildPath = new URL("../scripts/build.mjs", import.meta.url);
const codegenPath = new URL("../src/github/codegen.ts", import.meta.url);
const packagePath = new URL("../package.json", import.meta.url);
const readmePath = new URL("../README.md", import.meta.url);
const tsconfigPath = new URL("../tsconfig.json", import.meta.url);
const commonPath = fileURLToPath(
  new URL("../features/heddle/common.sh", import.meta.url),
);

interface FeatureOption {
  readonly default: string;
  readonly type: string;
}

interface FeatureManifest {
  readonly id: string;
  readonly options: Record<string, FeatureOption>;
}

describe("Heddle deployment", () => {
  it("exposes only file locations for secrets", async () => {
    const manifest = JSON.parse(
      await readFile(manifestPath, "utf8"),
    ) as FeatureManifest;

    expect(manifest.id).toBe("heddle");
    expect(manifest.options["githubAppCredentialsFile"]).toMatchObject({
      default: "/run/secrets/heddle-github-app.yml",
    });
    expect(manifest.options["t3CodeTokenFile"]).toMatchObject({
      default: "/run/secrets/heddle-t3-token",
    });
    expect(manifest.options["webhookSecretFile"]).toMatchObject({
      default: "/run/secrets/heddle-webhook-secret",
    });
    expect(Object.keys(manifest.options)).not.toContain("token");
    expect(Object.keys(manifest.options)).not.toContain("secret");
  });

  it.each([
    ["relative/config.yml", "absolute path"],
    ["/tmp/config.yml\nsecond-value", "unsupported characters"],
  ])("rejects unsafe Feature path %j", (value, expectedError) => {
    const result = spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; validate_absolute_path configFile "$2"',
        "bash",
        commonPath,
        value,
      ],
      { encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(expectedError);
  });

  it("accepts an absolute Feature path", () => {
    const result = spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; validate_absolute_path configFile "$2"',
        "bash",
        commonPath,
        "/tmp/config.yml",
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it.each([0, 2])("rejects %i packed packages", async (packageCount) => {
    const directory = await mkdtemp(join(tmpdir(), "heddle-feature-test-"));
    try {
      await Promise.all(
        Array.from({ length: packageCount }, (_, index) =>
          writeFile(
            join(directory, `wyrd-company-heddle-0.0.${String(index)}.tgz`),
            "fixture",
          ),
        ),
      );

      const result = spawnSync(
        "bash",
        [
          "-c",
          'source "$1"; find_single_package "$2"',
          "bash",
          commonPath,
          directory,
        ],
        { encoding: "utf8" },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("exactly one packed");
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  it("selects the only packed package", async () => {
    const directory = await mkdtemp(join(tmpdir(), "heddle-feature-test-"));
    const packagePath = join(directory, "wyrd-company-heddle-0.0.0.tgz");
    try {
      await writeFile(packagePath, "fixture");

      const result = spawnSync(
        "bash",
        [
          "-c",
          'source "$1"; find_single_package "$2"',
          "bash",
          commonPath,
          directory,
        ],
        { encoding: "utf8" },
      );

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(packagePath);
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  it.each([
    ["CONFIGFILE", "--config"],
    ["STATEDIRECTORY", "--state"],
    ["GITHUBAPPCREDENTIALSFILE", "--github-app-credentials"],
    ["T3CODETOKENFILE", "--t3-token"],
    ["WEBHOOKSECRETFILE", "--webhook-secret"],
  ])("carries %s into the %s service argument", async (option, flag) => {
    const installer = await readFile(installerPath, "utf8");

    expect(installer).toContain(`"\${${option}}"`);
    expect(installer).toContain(flag);
  });

  it("registers one Heddle longrun in the s6 user bundle", async () => {
    const installer = await readFile(installerPath, "utf8");

    expect(installer).toContain("/etc/s6-overlay/s6-rc.d/heddle");
    expect(installer).toContain("printf 'longrun\\n'");
    expect(installer).toContain(
      "touch /etc/s6-overlay/user-bundles.d/user/contents.d/heddle",
    );
    expect(installer).toContain(
      "exec s6-setuidgid ${quoted_user} /usr/local/bin/heddle-service",
    );
  });

  it("bundles both internal clients instead of external package names", async () => {
    const buildScript = await readFile(buildPath, "utf8");

    expect(buildScript).toContain('"src/github/src/"');
    expect(buildScript).toContain('"src/t3code/src/"');
    expect(buildScript).not.toMatch(
      /external:[\s\S]*@wyrd-company\/(?:github-work|t3code-client)/,
    );
    expect(buildScript).not.toContain("../../../github-spike");
    expect(buildScript).not.toContain("../../../t3code-client");
  });

  it("typechecks internal modules without workspace path aliases", async () => {
    const tsconfig = JSON.parse(await readFile(tsconfigPath, "utf8")) as {
      compilerOptions: { paths?: Record<string, string[]> };
      include: string[];
    };

    expect(tsconfig.include).toContain("src");
    expect(tsconfig.compilerOptions.paths).toBeUndefined();
  });

  it("generates the internal GitHub document lookup before compilation", async () => {
    const [codegen, manifestText] = await Promise.all([
      readFile(codegenPath, "utf8"),
      readFile(packagePath, "utf8"),
    ]);
    const manifest = JSON.parse(manifestText) as {
      scripts: Record<string, string>;
    };

    expect(codegen).toContain('schema: "src/github/schema/github.graphql"');
    expect(codegen).toContain('documents: ["src/github/src/**/*.ts"');
    expect(codegen).toContain('"src/github/src/generated/"');
    expect(manifest.scripts["build"]).toContain("npm run codegen");
  });

  it("documents the clients as internal modules", async () => {
    const readme = await readFile(readmePath, "utf8");

    expect(readme).toContain("## Internal modules");
    expect(readme).toContain("`src/t3code/`");
    expect(readme).toContain("`src/github/`");
    expect(readme).not.toMatch(/@wyrd-company\/(?:github-work|t3code-client)/);
  });

  it("exports both internal client public surfaces", async () => {
    const heddle = await import("../src/index.js");

    expect(heddle.github.github).toBeTypeOf("function");
    expect(heddle.github.ScriptedTransport).toBeTypeOf("function");
    expect(heddle.t3code.T3Client).toBeTypeOf("function");
  });
});
