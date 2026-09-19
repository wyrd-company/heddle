import { describe, expect, it } from "vitest";
import { defineProject } from "../schema/define.js";
import { pipelineFields } from "./fixtures.test-support.js";
import { specsFromSchema, verifySchema } from "./verify.js";

const board = defineProject({
  title: "Recipe pipeline",
  fields: {
    Status: { type: "singleSelect", options: ["Idea", "Drafting", "Archived"] },
    Servings: { type: "text" },
    Cuisine: { type: "singleSelect", options: ["Thai"] },
    Priority: { type: "issueField" },
  },
});

describe("verifySchema", () => {
  it("reports missing fields, type mismatches and missing options", () => {
    expect(verifySchema(board, pipelineFields())).toEqual([
      { kind: "missing-option", field: "Status", detail: "Archived" },
      { kind: "type-mismatch", field: "Servings", detail: "text vs number" },
      { kind: "missing-field", field: "Cuisine" },
    ]);
  });

  it("is empty when the live fields satisfy the declaration", () => {
    const conformant = defineProject({
      title: "x",
      fields: { Status: { type: "singleSelect", options: ["Idea"] }, Servings: { type: "number" } },
    });
    expect(verifySchema(conformant, pipelineFields())).toEqual([]);
  });

  it("derives catalog specs in declaration order", () => {
    expect(specsFromSchema(board).map((s) => s.name)).toEqual([
      "Status",
      "Servings",
      "Cuisine",
      "Priority",
    ]);
  });
});
