// ---
// relationships:
//   verifies: heddle
// ---

import { describe, expect, it } from "vitest";

import type { BoardTask } from "../board-adapter/index.js";
import type { ProductionConfiguration } from "./configuration.js";
import {
  ProductRoutingCatalog,
  TaskRoutingAttentionError,
} from "./product-routing.js";

const configuration = {
  products: [
    {
      name: "Sample product",
      repos: [
        { name: "sample-alpha", repositoryRoot: "/tmp/sample-alpha" },
        { name: "sample-beta", repositoryRoot: "/tmp/sample-beta" },
      ],
    },
    {
      name: "Second product",
      repos: [{ name: "sample-gamma", repositoryRoot: "/tmp/sample-gamma" }],
    },
  ],
} as ProductionConfiguration;

const task = (
  input: Partial<BoardTask> & Pick<BoardTask, "id">,
): BoardTask => ({
  blocked: false,
  dependencies: [],
  priority: "medium",
  status: "todo",
  tags: [],
  title: "Arrange sample items",
  ...input,
});

describe("ProductRoutingCatalog", () => {
  it("inherits an epic product and repository declaration", () => {
    const catalog = new ProductRoutingCatalog(configuration);
    const epic = task({
      id: 101,
      product: "Sample product",
      repos: ["sample-beta"],
      tags: ["type:epic"],
    });
    const child = task({ id: 102, parent: 101 });
    catalog.update([epic, child]);

    expect(catalog.route(child)).toMatchObject({
      product: { name: "Sample product" },
      repositories: [{ name: "sample-beta" }],
    });
  });

  it("fails with attention when a stage requires an undeclared repository", () => {
    const catalog = new ProductRoutingCatalog(configuration);
    const selected = task({
      id: 103,
      product: "Sample product",
      repos: ["sample-alpha"],
    });
    catalog.update([selected]);

    expect(() => catalog.repositoryForStage(selected, "sample-beta")).toThrow(
      expect.objectContaining<TaskRoutingAttentionError>({
        code: "stage-repository-undeclared",
      }),
    );
  });

  it("fails with attention when a task names a repository in no product", () => {
    const catalog = new ProductRoutingCatalog(configuration);
    const selected = task({
      id: 105,
      product: "Sample product",
      repos: ["sample-missing"],
    });
    catalog.update([selected]);

    expect(() => catalog.route(selected)).toThrow(
      expect.objectContaining<TaskRoutingAttentionError>({
        code: "repository-not-declared",
      }),
    );
  });

  it("fails with attention instead of guessing between product repositories", () => {
    const catalog = new ProductRoutingCatalog(configuration);
    const selected = task({ id: 104, product: "Sample product" });
    catalog.update([selected]);

    expect(() => catalog.repositoryForStage(selected)).toThrow(
      expect.objectContaining<TaskRoutingAttentionError>({
        code: "stage-repository-not-declared",
      }),
    );
  });
});
