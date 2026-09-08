// ---
// relationships:
//   verifies: heddle
// ---

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  T3ProviderCatalog,
  T3ProviderCatalogReader,
} from "../control-plane/index.js";
import {
  nativeDriverEvidenceLine,
  nativeProviderTurnFailureEvidenceLine,
  PREFERRED_MODEL_SLUGS,
  preferredModelsFor,
  QUALIFICATION_SECOND_DRIVER,
  QualificationModelSelectionError,
  requiredObservedCliVersion,
  safeT3StartupDiagnostic,
  startIsolatedT3,
} from "./driver-qualification.test-support.js";

const failureEvidence = {
  advanceResult: null,
  benignFileAction: null,
  driver: "sample-driver",
  listProvidersResult: null,
  model: "sample-model",
  providerAlias: "sample-alias",
  providerCliVersion: "1.2.3",
  providerInstanceId: "sample-instance",
  runtimeMode: "full-access",
  spawnResult: null,
  version: 1,
} as const;

const catalogWithModel = (
  model: string,
  observedCliVersion: string | null = "1.2.3",
): T3ProviderCatalog => [
  {
    availability: "available",
    displayName: QUALIFICATION_SECOND_DRIVER.displayName,
    driverKind: QUALIFICATION_SECOND_DRIVER.driver,
    enabled: true,
    installed: true,
    instanceId: QUALIFICATION_SECOND_DRIVER.instanceId,
    models: [
      {
        isCustom: false,
        name: "Unapproved model",
        slug: model,
      },
    ],
    observedCliVersion,
    state: "ready",
  },
];

describe("native qualification model approval", () => {
  it("fails closed when a ready provider omits its approved model", async () => {
    const reader: T3ProviderCatalogReader = {
      readProviderCatalog: vi.fn(async () =>
        catalogWithModel("unapproved-model"),
      ),
    };

    await expect(
      preferredModelsFor(reader, [QUALIFICATION_SECOND_DRIVER], 1),
    ).rejects.toThrow(
      new QualificationModelSelectionError(
        `Provider instance '${QUALIFICATION_SECOND_DRIVER.instanceId}' does not expose operator-approved qualification model '${PREFERRED_MODEL_SLUGS[QUALIFICATION_SECOND_DRIVER.instanceId]}'`,
      ),
    );
  });

  it("returns only the exact approved model", async () => {
    const approved =
      PREFERRED_MODEL_SLUGS[QUALIFICATION_SECOND_DRIVER.instanceId];
    const reader: T3ProviderCatalogReader = {
      readProviderCatalog: vi.fn(async () => catalogWithModel(approved ?? "")),
    };

    await expect(
      preferredModelsFor(reader, [QUALIFICATION_SECOND_DRIVER], 1),
    ).resolves.toEqual(
      new Map([[QUALIFICATION_SECOND_DRIVER.instanceId, approved]]),
    );
  });

  it("fails closed when an instance has no approved model mapping", async () => {
    const instance = { instanceId: "unmapped-instance" };
    const reader: T3ProviderCatalogReader = {
      readProviderCatalog: vi.fn(async () => [
        {
          ...catalogWithModel("unapproved-model")[0],
          instanceId: instance.instanceId,
        },
      ]),
    };

    await expect(preferredModelsFor(reader, [instance], 1)).rejects.toThrow(
      new QualificationModelSelectionError(
        "Provider instance 'unmapped-instance' has no operator-approved qualification model",
      ),
    );
  });

  it("formats one complete non-secret native evidence row", () => {
    expect(
      nativeDriverEvidenceLine({
        advanceResult: "review",
        benignFileAction: "native-driver-qualified",
        driver: "sample-driver",
        listProvidersResult: "selected-generated-alias",
        model: "sample-model",
        providerAlias: "sample-alias",
        providerCliVersion: "1.2.3",
        providerInstanceId: "sample-instance",
        result: "passed",
        runtimeMode: "full-access",
        spawnResult: "persisted-child-assignment",
        version: 1,
      }),
    ).toBe(
      'HEDDLE_NATIVE_EVIDENCE {"advanceResult":"review","benignFileAction":"native-driver-qualified","driver":"sample-driver","listProvidersResult":"selected-generated-alias","model":"sample-model","providerAlias":"sample-alias","providerCliVersion":"1.2.3","providerInstanceId":"sample-instance","result":"passed","runtimeMode":"full-access","spawnResult":"persisted-child-assignment","version":1}',
    );
  });

  it("fails closed when T3 omits the native CLI version", async () => {
    const reader: T3ProviderCatalogReader = {
      readProviderCatalog: vi.fn(async () =>
        catalogWithModel("approved-model", null),
      ),
    };

    await expect(
      requiredObservedCliVersion(
        reader,
        QUALIFICATION_SECOND_DRIVER.instanceId,
      ),
    ).rejects.toThrow(
      `T3 did not report a CLI version for '${QUALIFICATION_SECOND_DRIVER.instanceId}'`,
    );
  });
});

describe("native qualification failure evidence", () => {
  it("emits a row for an explicitly failed provider prompt", () => {
    expect(
      nativeProviderTurnFailureEvidenceLine(
        {
          id: "thread-1",
          latestTurn: { state: "error" },
          session: {
            lastError:
              "Provider adapter request failed (sample-provider) for session/prompt: sample limit reached",
            status: "error",
          },
        },
        "sample-provider",
        failureEvidence,
      ),
    ).toBe(
      'HEDDLE_NATIVE_EVIDENCE {"advanceResult":null,"benignFileAction":null,"driver":"sample-driver","listProvidersResult":null,"model":"sample-model","providerAlias":"sample-alias","providerCliVersion":"1.2.3","providerInstanceId":"sample-instance","result":"provider-turn-failed","runtimeMode":"full-access","spawnResult":null,"version":1}',
    );
  });

  it("emits no provider failure row for an unfinished turn", () => {
    expect(
      nativeProviderTurnFailureEvidenceLine(
        {
          id: "thread-1",
          latestTurn: { state: "running" },
          session: { status: "running" },
        },
        "sample-provider",
        failureEvidence,
      ),
    ).toBeNull();
  });

  it("emits no provider failure row without a failed latest turn", () => {
    expect(
      nativeProviderTurnFailureEvidenceLine(
        {
          id: "thread-1",
          session: {
            lastError:
              "Provider adapter request failed (sample-provider) for session/prompt: sample limit reached",
            status: "error",
          },
        },
        "sample-provider",
        failureEvidence,
      ),
    ).toBeNull();
  });

  it("emits no provider failure row unless the observed phase is failed", () => {
    expect(
      nativeProviderTurnFailureEvidenceLine(
        {
          hasPendingUserInput: true,
          id: "thread-1",
          latestTurn: { state: "error" },
          session: {
            lastError:
              "Provider adapter request failed (sample-provider) for session/prompt: sample limit reached",
            status: "error",
          },
        },
        "sample-provider",
        failureEvidence,
      ),
    ).toBeNull();
  });

  it("emits no provider failure row for a non-provider session failure", () => {
    expect(
      nativeProviderTurnFailureEvidenceLine(
        {
          id: "thread-1",
          latestTurn: { state: "error" },
          session: {
            lastError: "Session setup failed",
            status: "error",
          },
        },
        "sample-provider",
        failureEvidence,
      ),
    ).toBeNull();
  });
});

describe("isolated T3 startup diagnostics", () => {
  it("reports a bounded redacted reason when T3 exits before pairing", async () => {
    const root = await mkdtemp(join(tmpdir(), "heddle-t3-early-exit-test-"));
    try {
      const binary = join(root, "t3-fixture.mjs");
      await writeFile(
        binary,
        `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("t3 v0.0.0-fixture\\n");
} else {
  process.stderr.write("Startup detail " + "x".repeat(70_000) + "\\n");
  process.stderr.write("Authorization: Bearer fixture-secret\\n");
  process.stderr.write("Error: fixture startup refused\\n");
  process.exitCode = 1;
}
`,
      );
      await chmod(binary, 0o755);

      const failure = await startIsolatedT3({
        binary,
        scratch: join(root, "scratch"),
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toContain(
        "Isolated T3 exited before pairing (code 1): Error: fixture startup refused",
      );
      expect(message).not.toContain("fixture-secret");
      expect(message.length).toBeLessThanOrEqual(2_100);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it.each([
    ["pairing token", "Token: pairing-secret", "pairing-secret"],
    ["bearer token", "Bearer bearer-secret", "bearer-secret"],
    ["API key", "api_key=api-secret", "api-secret"],
    ["access token", "access_token=access-secret", "access-secret"],
    ["authorization", "authorization=auth-secret", "auth-secret"],
    ["generic secret", "secret: generic-secret", "generic-secret"],
    [
      "quoted access token",
      'Error: {"access_token": "quoted credential value"}',
      "quoted credential value",
    ],
    [
      "single-quoted API key",
      "Error: api_key='single-quoted-secret'",
      "single-quoted-secret",
    ],
  ])("redacts a %s from startup diagnostics", (_name, output, secret) => {
    const diagnostic = safeT3StartupDiagnostic(output);
    expect(diagnostic).not.toContain(secret);
    expect(diagnostic).toContain("[redacted]");
  });

  it("redacts the complete quoted structured credential value", () => {
    expect(
      safeT3StartupDiagnostic(
        'Error: {"access_token": "quoted credential value"}',
      ),
    ).toBe('Error: {"access_token": "[redacted]"}');
  });

  it("bounds the startup classification", () => {
    const bounded = safeT3StartupDiagnostic(
      `Fatal: fixture stopped ${"x".repeat(70_000)}`,
    );
    expect(bounded).toContain("Fatal: fixture stopped");
    expect(bounded.length).toBe(2_000);
  });

  it("removes terminal control sequences from the startup classification", () => {
    expect(
      safeT3StartupDiagnostic("\u001b[31mError: fixture stopped\u001b[0m"),
    ).toBe("Error: fixture stopped");
  });

  it.each([
    [
      "BEL-terminated OSC",
      `${String.fromCharCode(27)}]0;private title${String.fromCharCode(7)}Error: fixture stopped`,
    ],
    [
      "ST-terminated OSC",
      `${String.fromCharCode(27)}]0;private title${String.fromCharCode(27)}\\Error: fixture stopped`,
    ],
    ["remaining C0", `Error: fixture${String.fromCharCode(8)} stopped`],
  ])("removes %s terminal controls", (_name, output) => {
    const diagnostic = safeT3StartupDiagnostic(output);
    expect(diagnostic).not.toContain("private title");
    expect(diagnostic).toBe("Error: fixture stopped");
  });
});
