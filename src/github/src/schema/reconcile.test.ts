import { describe, expect, it } from "vitest";
import { reconcile, type ReconcileOption } from "./reconcile.js";
import type { OptionSpec } from "./types.js";

interface Spec {
  name: string;
  type: string;
  color?: string;
  options?: readonly OptionSpec[];
}
interface Actual {
  id: string;
  name: string;
  type: string;
  color: string;
  options?: ReconcileOption[];
}

const plan = (declared: Spec[], actual: Actual[], reportUnmanaged = false) =>
  reconcile<Spec, Actual>({
    declared,
    actual,
    keyOf: (v) => v.name,
    typeOf: (v) => v.type,
    diff: (s, e) => (s.color !== undefined && s.color !== e.color ? ["color"] : []),
    reportUnmanaged,
  });

describe("reconcile", () => {
  it("creates missing, updates differing, leaves matching alone", () => {
    const result = plan(
      [
        { name: "vegan", type: "label", color: "0e8a16" },
        { name: "quick", type: "label", color: "fbca04" },
        { name: "same", type: "label", color: "ffffff" },
      ],
      [
        { id: "1", name: "quick", type: "label", color: "000000" },
        { id: "2", name: "same", type: "label", color: "ffffff" },
      ],
    );
    expect(result.changes).toEqual([
      { kind: "created", name: "vegan" },
      { kind: "updated", name: "quick", properties: ["color"] },
      { kind: "unchanged", name: "same" },
    ]);
    expect(result.operations).toEqual([
      { kind: "create", spec: { name: "vegan", type: "label", color: "0e8a16" } },
      { kind: "update", name: "quick", patch: { color: "fbca04" } },
    ]);
  });

  it("appends and updates options by name, keeps unmanaged ones, never deletes", () => {
    const result = plan(
      [
        {
          name: "Status",
          type: "singleSelect",
          options: ["Idea", { name: "Drafting", color: "BLUE" }, "Published"],
        },
      ],
      [
        {
          id: "f1",
          name: "Status",
          type: "singleSelect",
          color: "",
          options: [
            { id: "o1", name: "Idea", color: "GRAY" },
            { id: "o2", name: "Drafting", color: "GRAY" },
            { id: "o3", name: "Archived", color: "GRAY" },
          ],
        },
      ],
      true,
    );
    expect(result.changes).toEqual([
      { kind: "option-updated", field: "Status", option: "Drafting", properties: ["color"] },
      { kind: "option-added", field: "Status", option: "Published" },
      { kind: "option-unmanaged", field: "Status", option: "Archived" },
      { kind: "updated", name: "Status", properties: ["options"] },
    ]);
    expect(result.operations).toEqual([
      {
        kind: "update",
        name: "Status",
        patch: {
          options: [
            { id: "o1", name: "Idea", color: "GRAY" },
            { id: "o2", name: "Drafting", color: "BLUE" },
            { name: "Published" },
            { id: "o3", name: "Archived", color: "GRAY" },
          ],
        },
      },
    ]);
  });

  it("reports type mismatches and unmanaged resources without operations", () => {
    const result = plan(
      [{ name: "Servings", type: "number" }],
      [
        { id: "1", name: "Servings", type: "text", color: "" },
        { id: "2", name: "Cuisine", type: "singleSelect", color: "" },
      ],
      true,
    );
    expect(result.changes).toEqual([
      { kind: "type-mismatch", name: "Servings", expected: "number", actual: "text" },
      { kind: "field-unmanaged", field: "Cuisine" },
    ]);
    expect(result.operations).toEqual([]);
  });
});
