// ---
// relationships:
//   verifies: heddle
// ---

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
