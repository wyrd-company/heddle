// ---
// relationships:
//   verifies: heddle
//   references: t3-headless
// ---

import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const featureDirectory = "features/heddle";
const execute = promisify(execFile);

describe("Heddle devcontainer feature", () => {
  it.each([
    "AGENTS.md",
    "docs/operators/production-composition.md",
    "docs/technical-designs/heddle.yml",
  ])(
    "keeps %s aligned with the approved supported T3 release",
    async (path) => {
      const versions = JSON.parse(
        await readFile("deployment/supported-versions.json", "utf8"),
      );
      const document = await readFile(path, "utf8");
      expect(document).toContain(versions.t3);
      expect(document.match(/0\.0\.\d+-wyrd\.\d+/g)).toEqual([versions.t3]);
    },
  );
  it("declares independent package resolution and service options", async () => {
    const manifest = JSON.parse(
      await readFile(`${featureDirectory}/devcontainer-feature.json`, "utf8"),
    ) as {
      options: Record<string, { default: string }>;
      installsAfter: string[];
    };

    expect(manifest.options).toMatchObject({
      version: { default: "latest" },
      packageSource: { default: "" },
      packageSha256: { default: "" },
      npmRegistry: { default: "https://registry.npmjs.org" },
      configDirectory: { default: "/home/vscode/.heddle" },
      dnsName: { default: "" },
    });
    expect(manifest.options).not.toHaveProperty("boardPath");
    expect(manifest.options).not.toHaveProperty("port");
    expect(manifest.options).not.toHaveProperty("statePath");
    expect(manifest.installsAfter).toContain(
      "ghcr.io/wyrd-company/devcontainers/caddy",
    );
  });

  it("binds s6, state-mount, installed-package, and Caddy agreements", async () => {
    const common = await readFile(`${featureDirectory}/common.sh`, "utf8");
    const installer = await readFile(`${featureDirectory}/install.sh`, "utf8");

    expect(common).toContain("apt-get install -y --no-install-recommends");
    expect(installer).toContain("ensure_apt_packages ca-certificates curl jq");
    expect(installer).not.toMatch(/\b(?:build-essential|python3)\b/u);
    expect(installer).toContain(
      '"$(dirname "$0")/verify-feature-source.sh" "$(dirname "$0")"',
    );
    expect(installer).not.toContain("heddle-source");
    expect(installer).not.toMatch(/npm (?:ci|run)\b/u);
    expect(installer).not.toMatch(/npm pack[^\n]*"\$\{repository\}"/u);
    expect(installer).not.toContain(
      'packages=("$(dirname "$0")"/heddle-*.tgz)',
    );
    expect(installer).toContain("--allow-scripts=better-sqlite3");
    expect(installer).toContain('--registry "${NPMREGISTRY}"');
    expect(installer).toContain('"--@wyrd-company:registry=${NPMREGISTRY}"');
    expect(installer).toContain("npm pack --silent --json --ignore-scripts");
    expect(installer).toContain(
      "Heddle package resolution from ${NPMREGISTRY} failed for ${package_source}.",
    );
    expect(installer).toContain(
      "lib/node_modules/@wyrd-company/heddle/node_modules/better-sqlite3",
    );
    const finalInstall = installer.slice(
      installer.indexOf('log "Installing the prebuilt Heddle package"'),
    );
    expect(finalInstall).toContain("CC=/bin/false");
    expect(finalInstall).toContain("CXX=/bin/false");
    expect(installer).toContain(
      "No matching better-sqlite3 prebuild exists for platform",
    );
    expect(installer).toContain("Node ABI ${node_abi}");
    expect(installer).toContain('log "Registering the Heddle service"');
    const digestGuard = installer.indexOf("packageSha256");
    const serviceRegistration = installer.indexOf(
      "/etc/s6-overlay/s6-rc.d/heddle",
    );
    expect(digestGuard).toBeGreaterThan(-1);
    expect(serviceRegistration).toBeGreaterThan(digestGuard);
    expect(installer).toContain(
      [
        "/usr/local/bin/heddle-server \\",
        '    --config "\\${config_directory}" \\',
        "    --print-launch-settings",
      ].join("\n"),
    );
    expect(installer).toContain('mountpoint -q "\\${state_path}"');
    expect(installer).toContain(
      'state_path="\\$(jq -er \'.stateDirectory\' <<<"\\${launch_settings}")"',
    );
    expect(installer).toContain(
      'host="\\$(jq -er \'.host\' <<<"\\${launch_settings}")"',
    );
    expect(installer).toContain(
      'port="\\$(jq -er \'.port\' <<<"\\${launch_settings}")"',
    );
    expect(installer).toContain("expected_kanban_version=0.38.0-fork+794efef");
    expect(installer).toContain(
      '/usr/local/libexec/heddle/check-kanban-version "\\${expected_kanban_version}"',
    );
    expect(installer).not.toContain("export HEDDLE_BOARD_PATH");
    expect(installer).not.toContain("export HEDDLE_HOST");
    expect(installer).not.toContain("export HEDDLE_PORT");
    expect(installer).not.toContain("export HEDDLE_STATE_PATH");
    expect(installer).toContain(
      [
        "exec s6-setuidgid ${quoted_user} \\",
        '    /usr/local/bin/heddle-server --config "\\${config_directory}"',
      ].join("\n"),
    );
    expect(installer.split("\n")).toContain(
      "touch /etc/s6-overlay/user-bundles.d/user/contents.d/heddle",
    );
    expect(installer).toContain(
      'mv "\\${caddy_temp}" /etc/caddy/conf.d/heddle.caddy',
    );
    expect(installer).toContain(
      "timeout --signal=TERM --kill-after=1 10 \\\n" +
        "        bash -c 'until /usr/local/bin/caddy-reload >/dev/null 2>&1; do sleep 0.1; done'",
    );
    expect(installer).toContain(
      "Caddy did not accept the configured Heddle endpoint.",
    );
    expect(installer).toContain('"\\${dns_name}" "\\${host}" "\\${port}"');
    expect(installer).not.toContain("reverse_proxy 127.0.0.1:");
  });

  it("requires the complete supported kanban-md version output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "heddle-kanban-version-"));
    const fakeKanban = join(directory, "kanban-md");
    await writeFile(
      fakeKanban,
      '#!/bin/sh\nprintf "%s\\n" "$KANBAN_VERSION_OUTPUT"\n',
    );
    await chmod(fakeKanban, 0o755);
    const environment = {
      ...process.env,
      PATH: `${directory}:${process.env.PATH ?? ""}`,
    };
    const check = `${featureDirectory}/check-kanban-version.sh`;

    try {
      await expect(
        execute(check, ["0.38.0-fork+794efef"], {
          env: {
            ...environment,
            KANBAN_VERSION_OUTPUT: "kanban-md version 0.38.0-fork+794efef",
          },
        }),
      ).resolves.toMatchObject({ stderr: "" });
      for (const output of [
        "wrapper kanban-md version 0.38.0-fork+794efef",
        "kanban-md version 0.38.0-fork+794efef-extra",
        "kanban-md version 0.38.0-fork+794efef wrapped",
      ]) {
        await expect(
          execute(check, ["0.38.0-fork+794efef"], {
            env: { ...environment, KANBAN_VERSION_OUTPUT: output },
          }),
        ).rejects.toMatchObject({ code: 1 });
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it.each(["state", "board", "tools", "config", "publication"])(
    "cleans scratch resources when the %s allocation fails",
    async (allocation) => {
      const scratchRoot = await mkdtemp(
        join(tmpdir(), "heddle-allocation-failure-"),
      );
      try {
        await expect(
          execute("bash", ["scripts/deployment/qualify-feature.sh"], {
            env: {
              ...process.env,
              HEDDLE_QUALIFICATION_FAIL_ALLOCATION: allocation,
              HEDDLE_QUALIFICATION_SCRATCH_ROOT: scratchRoot,
            },
          }),
        ).rejects.toMatchObject({ code: 1 });
        await expect(readdir(scratchRoot)).resolves.toEqual([]);
      } finally {
        await rm(scratchRoot, { force: true, recursive: true });
      }
    },
  );

  it("pins qualification and documents every isolation boundary", async () => {
    const versions = JSON.parse(
      await readFile("deployment/supported-versions.json", "utf8"),
    ) as { kanbanMd: string; t3: string; t3PackageSource: string };
    const readme = await readFile(`${featureDirectory}/README.md`, "utf8");
    const qualification = await readFile(
      "scripts/deployment/qualify-pinned-t3.mjs",
      "utf8",
    );
    const featureQualification = await readFile(
      "scripts/deployment/qualify-feature.sh",
      "utf8",
    );

    expect(versions.t3).toBe("0.0.38-wyrd.2");
    expect(versions.t3PackageSource).toBe(
      "https://github.com/wyrd-company/t3code/releases/download/server/0.0.38-wyrd.2/t3-0.0.38-wyrd.2.tgz",
    );
    expect(versions.kanbanMd).toBe("0.38.0-fork+794efef");
    expect(readme).toContain(
      `supports the Wyrd Company T3 fork \`${versions.t3}\``,
    );
    expect(featureQualification).toContain("jq -er '.t3PackageSource'");
    expect(featureQualification).toContain(
      "npm install --global --no-audit --no-fund --prefix",
    );
    expect(featureQualification).toContain("HEDDLE_T3_BINARY=");
    expect(featureQualification).toContain("${prefix}/bin/t3");
    expect(qualification).toContain('t3Binary === "/usr/local/bin/t3"');
    expect(qualification).toContain("registerWorkflowMcpProviderSession");
    expect(qualification).toContain('t3Binary === "/home/vscode/.t3"');
    expect(qualification).toContain(
      'installedPackage !== "/usr/local/lib/node_modules/@wyrd-company/heddle"',
    );
    expect(qualification).toContain("port === 3773");
    expect(qualification).toContain("dirname(process.execPath)");
    expect(qualification).toContain("observedVersion !== expectedVersion");
    expect(qualification).toContain("match(/^t3 v(\\S+)$/)?.[1]");
    expect(featureQualification).toContain(
      'git -C "${repository}" diff --quiet',
    );
    expect(featureQualification).toContain(
      'chmod 0600 "${config_directory}/config.yml"',
    );
    expect(featureQualification).toContain(
      'feature_version="$(jq -r \'.version\' "${repository}/features/heddle/devcontainer-feature.json")"',
    );
    expect(featureQualification).toContain(
      'feature_major="${feature_version%%.*}"',
    );
    expect(featureQualification).toContain(
      'published_feature_reference="ghcr.io/wyrd-company/heddle/heddle:${feature_major}"',
    );
    expect(featureQualification).toContain("devcontainer features publish");
    expect(featureQualification).toContain("--namespace wyrd-company/heddle");
    expect(featureQualification).toContain(
      'dry_published_reference="localhost:${registry_port}/wyrd-company/heddle/heddle:${feature_major}"',
    );
    expect(featureQualification).toContain(
      '    "/opt/heddle-package.tgz" \\\n    "${package_digest}"',
    );
    expect(featureQualification).toContain("packageSha256: $package_digest");
    expect(featureQualification).toContain("npmRegistry: $npm_registry,");
    expect(featureQualification).toContain("version: $package_version");
    expect(featureQualification).toContain(
      'npm_registry_url="http://${npm_registry_host}:${npm_registry_port}"',
    );
    expect(featureQualification).toContain(
      "docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}'",
    );
    expect(featureQualification).toContain(
      "grep -Fq 'No matching version found for @wyrd-company/heddle@9.9.9.'",
    );
    expect(featureQualification).toContain(
      "scripts/deployment/qualification-npm-registry.mjs",
    );
    expect(featureQualification).toContain(
      "expect_feature_install_failure \\\n    missing-registry-version",
    );
    expect(featureQualification).toContain(
      "failed for @wyrd-company/heddle@9\\\\.9\\\\.9",
    );
    expect(featureQualification).toContain(
      "'.name == \"@wyrd-company/heddle\" and .version == $version'",
    );
    expect(
      featureQualification.match(
        /'\.name == "@wyrd-company\/heddle" and \.version == \$version'/g,
      ),
    ).toHaveLength(2);
    expect(featureQualification).toContain(
      'grep -qx "GET /@wyrd-company/heddle/-/heddle-${package_version}.tgz" "${npm_registry_log}"',
    );
    const latestInstall = featureQualification.indexOf(
      '    "" \\\n    "${package_digest}" \\\n    "latest" \\\n    "heddle.localhost"',
    );
    const exactInstall = featureQualification.indexOf(
      '    "" \\\n    "${package_digest}" \\\n    "${package_version}" \\\n    "heddle.localhost"',
    );
    expect(latestInstall).toBeGreaterThan(-1);
    expect(exactInstall).toBeGreaterThan(latestInstall);
    const qualificationConfiguration = JSON.parse(
      await readFile(".devcontainer/qualification/devcontainer.json", "utf8"),
    ) as {
      mounts: Array<{ readonly?: boolean; source: string; target: string }>;
      runArgs: string[];
    };
    // Feature installation runs in docker build, where runArgs do not apply.
    expect(qualificationConfiguration.runArgs).not.toContain(
      "npm.qualification:host-gateway",
    );
    expect(qualificationConfiguration.mounts).toContainEqual(
      expect.objectContaining({
        readonly: true,
        source: "${localEnv:HEDDLE_QUALIFICATION_CONFIG}",
        target: "/home/vscode/.heddle",
      }),
    );
  });

  it("keeps the deployment qualification fixture aligned with the production schema", async () => {
    const qualification = await readFile(
      "scripts/deployment/qualify-feature.sh",
      "utf8",
    );
    const fixture = qualification.match(
      /cat >"\$\{config_directory\}\/config\.yml" <<'EOF'\n(?<yaml>[\s\S]*?)\nEOF/u,
    )?.groups?.["yaml"];
    expect(
      fixture,
      "deployment qualification config fixture is missing",
    ).toBeDefined();

    const configuration = parse(
      fixture!.replace("T3_MOCK_PORT", "3999"),
    ) as object;
    const schema = JSON.parse(
      await readFile("schemas/production-configuration.json", "utf8"),
    );
    const validate = new Ajv2020({
      allErrors: true,
      formats: { uri: true },
      strict: false,
    }).compile(schema);

    expect(
      validate(configuration),
      `deployment qualification config violates the production schema: ${JSON.stringify(validate.errors)}`,
    ).toBe(true);

    const themeFixture = qualification.match(
      /cat >"\$\{config_directory\}\/blueprints\/themes\/sample-team\.yml" <<'EOF'\n(?<yaml>[\s\S]*?)\nEOF/u,
    )?.groups?.["yaml"];
    expect(
      themeFixture,
      "deployment qualification agent-name theme fixture is missing",
    ).toBeDefined();
    const themeSchema = JSON.parse(
      await readFile("schemas/agent-name-theme.json", "utf8"),
    );
    const validateTheme = new Ajv2020({
      allErrors: true,
      strict: false,
    }).compile(themeSchema);
    expect(
      validateTheme(parse(themeFixture!)),
      `deployment qualification theme violates the agent-name theme schema: ${JSON.stringify(validateTheme.errors)}`,
    ).toBe(true);

    const blueprintFixture = qualification.match(
      /cat >"\$\{config_directory\}\/blueprints\/blueprints\/qualification\.json" <<'EOF'\n(?<json>[\s\S]*?)\nEOF/u,
    )?.groups?.["json"];
    expect(
      blueprintFixture,
      "deployment qualification lifecycle blueprint fixture is missing",
    ).toBeDefined();
    const blueprintSchema = JSON.parse(
      await readFile("schemas/lifecycle-blueprint.json", "utf8"),
    );
    const validateBlueprint = new Ajv2020({
      allErrors: true,
      strict: false,
    }).compile(blueprintSchema);
    expect(
      validateBlueprint(JSON.parse(blueprintFixture!)),
      `deployment qualification blueprint violates the lifecycle blueprint schema: ${JSON.stringify(validateBlueprint.errors)}`,
    ).toBe(true);
    expect(qualification).toContain(
      'git -C "${config_directory}/blueprints" add -- README.md blueprints themes',
    );

    const fixturePreflight = qualification.indexOf(
      "await themeCatalog.validateCurrent();",
    );
    const packageGate = qualification.indexOf(
      'task -d "${repository}" deployment:package',
    );
    expect(fixturePreflight).toBeGreaterThan(-1);
    expect(fixturePreflight).toBeLessThan(packageGate);
    expect(qualification).toContain('loaded.blueprintsSourceRoot,\n  "HEAD",');
  });

  it("routes every qualification container removal through verified identity", async () => {
    const qualification = await readFile(
      "scripts/deployment/qualify-feature.sh",
      "utf8",
    );
    const helperStart = qualification.indexOf("remove_owned_container() {");
    const helperEnd = qualification.indexOf("\ncleanup() {", helperStart);
    const removalInvocations = [
      ...qualification.matchAll(/^\s*docker rm --force /gm),
    ];

    expect(helperStart).toBeGreaterThanOrEqual(0);
    expect(helperEnd).toBeGreaterThan(helperStart);
    expect(removalInvocations).toHaveLength(1);
    expect(removalInvocations[0]?.index).toBeGreaterThan(helperStart);
    expect(removalInvocations[0]?.index).toBeLessThan(helperEnd);
    expect(qualification).toContain(
      [
        "remove_owned_container \\",
        '    "${container_id}" \\',
        "    heddle.qualification",
      ].join("\n"),
    );
  });

  it("provisions the derived qualification clone with an origin upstream", async () => {
    const qualification = await readFile(
      "scripts/deployment/qualify-feature.sh",
      "utf8",
    );

    expect(qualification).toContain(
      'git clone "${config_directory}/blueprints-origin.git" "${config_directory}/blueprints"',
    );
    expect(qualification).toContain(
      'git -C "${config_directory}/blueprints" remote set-url origin ../blueprints-origin.git',
    );
    expect(qualification).toContain(
      'git -C "${config_directory}/blueprints" push --set-upstream origin main',
    );
  });

  it("creates the nested artifact directory inside the generated blueprint repository", async () => {
    const qualification = await readFile(
      "scripts/deployment/qualify-feature.sh",
      "utf8",
    );
    const clone = qualification.indexOf(
      'git clone "${config_directory}/blueprints-origin.git" "${config_directory}/blueprints"',
    );
    const artifactDirectory = qualification.indexOf(
      'install -d -m 0755 "${config_directory}/blueprints/blueprints"',
    );
    const packageGate = qualification.indexOf(
      'task -d "${repository}" deployment:package',
    );

    expect(clone).toBeGreaterThan(-1);
    expect(artifactDirectory).toBeGreaterThan(clone);
    expect(artifactDirectory).toBeLessThan(packageGate);
  });
  it("keeps the version option intact across the distribution check", async () => {
    // /etc/os-release defines VERSION, and so does the Feature's version
    // option. A distribution check that sources it in the caller's shell
    // destroys the option, which made the published Feature reject
    // "24.04.4 LTS (Noble Numbat)" as invalid SemVer.
    const script = [
      "set -euo pipefail",
      'VERSION="0.1.0"',
      `source ${featureDirectory}/common.sh`,
      "check_debian_family",
      'printf "%s" "${VERSION}"',
    ].join("\n");

    const { stdout } = await execute("bash", ["-c", script]);

    expect(stdout).toBe("0.1.0");
  });

  it("rejects an npm registry that carries credentials or is not http", async () => {
    const validate = async (registry: string) =>
      execute("bash", [
        "-c",
        [
          "set -euo pipefail",
          `source ${featureDirectory}/common.sh`,
          'validate_npm_registry "$1"',
          'printf "accepted"',
        ].join("\n"),
        "validate",
        registry,
      ]);

    for (const registry of [
      "https://registry.npmjs.org",
      "http://172.17.0.1:4873",
      "https://npm.example.invalid/scoped/",
    ]) {
      await expect(validate(registry)).resolves.toMatchObject({
        stdout: "accepted",
      });
    }
    for (const registry of [
      "https://user:secret@npm.example.invalid/",
      "http://token@127.0.0.1:4873",
    ]) {
      await expect(validate(registry)).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining(
          "npmRegistry must not contain credentials",
        ),
      });
      await expect(validate(registry)).rejects.not.toMatchObject({
        stderr: expect.stringContaining("secret"),
      });
    }
    for (const registry of [
      "ftp://npm.example.invalid/",
      "registry.npmjs.org",
      "https://",
    ]) {
      await expect(validate(registry)).rejects.toMatchObject({ code: 1 });
    }
    const installer = await readFile(`${featureDirectory}/install.sh`, "utf8");
    const validation = installer.indexOf(
      'validate_npm_registry "${NPMREGISTRY}"',
    );
    const firstUse = installer.indexOf(
      'log "Fetching ${package_source} from ${NPMREGISTRY}"',
    );
    expect(validation).toBeGreaterThan(-1);
    expect(firstUse).toBeGreaterThan(validation);
  });

  it("snapshots the version option before sourcing any helper", async () => {
    const installer = await readFile(`${featureDirectory}/install.sh`, "utf8");
    const snapshot = installer.indexOf('heddle_option_version="${VERSION:-}"');
    const sourced = installer.indexOf('source "$(dirname "$0")/common.sh"');
    const resolution = installer.indexOf('"${heddle_option_version}")"');

    expect(snapshot).toBeGreaterThan(-1);
    expect(snapshot).toBeLessThan(sourced);
    expect(resolution).toBeGreaterThan(sourced);
    expect(installer).not.toContain('"${PACKAGESOURCE}" "${VERSION}"');
  });
});
