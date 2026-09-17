import { describe, expect, it } from "vitest";
import { pipelineFields } from "./fixtures.test-support.js";
import { encodeValue, fieldNamed } from "./values.js";

const fields = pipelineFields();
const f = (name: string) => fieldNamed(fields, name);

describe("encodeValue", () => {
  it("encodes each project field kind", () => {
    expect(encodeValue(f("Notes"), "hello")).toMatchObject({
      kind: "project",
      value: { text: "hello" },
    });
    expect(encodeValue(f("Servings"), 4)).toMatchObject({ value: { number: 4 } });
    expect(encodeValue(f("Due"), "2026-10-20")).toMatchObject({ value: { date: "2026-10-20" } });
    expect(encodeValue(f("Status"), "Drafting")).toMatchObject({
      value: { singleSelectOptionId: "s2" },
    });
    expect(encodeValue(f("Tags"), ["quick", "vegan"])).toMatchObject({
      value: { multiSelectOptionIds: ["t2", "t1"] },
    });
  });

  it("resolves iterations by containing date and by title, across completed ones", () => {
    expect(encodeValue(f("Publish week"), "2026-10-13")).toMatchObject({
      value: { iterationId: "it2" },
    });
    expect(encodeValue(f("Publish week"), "2026-10-04")).toMatchObject({
      value: { iterationId: "it0" },
    });
    expect(encodeValue(f("Publish week"), { title: "Week 1" })).toMatchObject({
      value: { iterationId: "it1" },
    });
    expect(() => encodeValue(f("Publish week"), "2027-01-01")).toThrow(/no iteration containing/);
    expect(() => encodeValue(f("Publish week"), { title: "Week 9" })).toThrow(
      /no iteration "Week 9"/,
    );
  });

  it("clears with null and rejects unknown options and wrong types", () => {
    expect(encodeValue(f("Status"), null)).toMatchObject({ kind: "project", value: null });
    expect(() => encodeValue(f("Status"), "Nope")).toThrow(/no option "Nope"/);
    expect(() => encodeValue(f("Servings"), "4")).toThrow(/needs a number/);
    expect(() => encodeValue(f("Title"), "x")).toThrow(/built in/);
  });

  it("encodes issue-field-backed fields as setIssueFieldValue entries", () => {
    expect(encodeValue(f("Priority"), "Low")).toEqual({
      kind: "issue",
      field: f("Priority"),
      value: { fieldId: "IFSS_1", singleSelectOptionId: "IFSSO_2" },
    });
    expect(encodeValue(f("Priority"), null)).toMatchObject({
      kind: "issue",
      value: { fieldId: "IFSS_1", delete: true },
    });
  });

  it("names unknown fields as a schema mismatch", () => {
    expect(() => fieldNamed(fields, "Ghost")).toThrow(/unknown-field Ghost/);
  });
});
