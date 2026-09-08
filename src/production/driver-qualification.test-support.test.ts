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
  PREFERRED_MODEL_SLUGS,
  preferredModelsFor,
  QUALIFICATION_SECOND_DRIVER,
  QualificationModelSelectionError,
} from "./driver-qualification.test-support.js";

const catalogWithModel = (model: string): T3ProviderCatalog => [
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
    observedCliVersion: "1.2.3",
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
});
