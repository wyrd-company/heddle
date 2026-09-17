import { describe, expect, it } from "vitest";
import type { IssueField } from "../owner/issue-fields.js";
import { nodeId } from "../refs.js";
import { encodeIssueFieldValue } from "./field-values.js";

const base = { description: null, visibility: "ALL" as const, options: [] };
const cuisine: IssueField = {
  ...base,
  id: nodeId("IFSS_1"),
  name: "Cuisine",
  type: "singleSelect",
  options: [
    { id: nodeId("O_1"), name: "Thai", color: "GRAY", description: null, priority: 1 },
    { id: nodeId("O_2"), name: "Italian", color: "BLUE", description: null, priority: 2 },
  ],
};

describe("encodeIssueFieldValue", () => {
  it("encodes each kind against its field id", () => {
    expect(
      encodeIssueFieldValue({ ...base, id: nodeId("IFT_1"), name: "Notes", type: "text" }, "x"),
    ).toEqual({ fieldId: "IFT_1", textValue: "x" });
    expect(
      encodeIssueFieldValue({ ...base, id: nodeId("IFN_1"), name: "Servings", type: "number" }, 4),
    ).toEqual({ fieldId: "IFN_1", numberValue: 4 });
    expect(
      encodeIssueFieldValue(
        { ...base, id: nodeId("IFD_1"), name: "Target", type: "date" },
        "2026-10-20",
      ),
    ).toEqual({ fieldId: "IFD_1", dateValue: "2026-10-20" });
    expect(encodeIssueFieldValue(cuisine, "Italian")).toEqual({
      fieldId: "IFSS_1",
      singleSelectOptionId: "O_2",
    });
    expect(encodeIssueFieldValue({ ...cuisine, type: "multiSelect" }, ["Thai", "Italian"])).toEqual(
      { fieldId: "IFSS_1", multiSelectOptionIds: ["O_1", "O_2"] },
    );
  });

  it("null deletes the value", () => {
    expect(encodeIssueFieldValue(cuisine, null)).toEqual({ fieldId: "IFSS_1", delete: true });
  });

  it("rejects unknown options and wrong value kinds with VALIDATION", () => {
    expect(() => encodeIssueFieldValue(cuisine, "French")).toThrow(/no option "French"/);
    expect(() => encodeIssueFieldValue(cuisine, 3)).toThrowError(
      expect.objectContaining({ code: "VALIDATION" }),
    );
  });
});
