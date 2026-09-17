import { describe, expect, expectTypeOf, it } from "vitest";
import { defineIssueFields, defineProject } from "./define.js";
import type { IssueFieldValues, Snapshot, Values } from "./types.js";

const issueFields = defineIssueFields({
  Priority: { type: "singleSelect", options: ["Urgent", "High", "Low"] },
  "Target date": { type: "date" },
  Tags: { type: "multiSelect", options: [{ name: "vegan", color: "GREEN" }, "quick"] },
});

const board = defineProject({
  title: "Recipe pipeline",
  fields: {
    Status: { type: "singleSelect", options: ["Idea", "Drafting", "Published"] },
    Servings: { type: "number" },
    "Publish week": { type: "iteration", startDate: "2026-10-05", duration: 7 },
    Notes: { type: "text" },
    Priority: { type: "issueField" },
    Orphan: { type: "issueField" },
  },
});

type S = typeof issueFields;
type P = typeof board;

describe("declared schemas", () => {
  it("keeps literals through define*", () => {
    expect(board.fields.Status.options).toEqual(["Idea", "Drafting", "Published"]);
    expect(issueFields.Priority.type).toBe("singleSelect");
    expectTypeOf(board.fields.Status.options).toEqualTypeOf<
      readonly ["Idea", "Drafting", "Published"]
    >();
  });

  it("types item values by field kind and option names", () => {
    const ok: Values<P, S> = {
      Status: "Drafting",
      Servings: 4,
      "Publish week": "2026-10-12",
      Notes: null,
      Priority: "High",
    };
    expect(ok.Status).toBe("Drafting");
    expectTypeOf<Values<P, S>["Status"]>().toEqualTypeOf<
      "Idea" | "Drafting" | "Published" | null | undefined
    >();
    expectTypeOf<Values<P, S>["Priority"]>().toEqualTypeOf<
      "Urgent" | "High" | "Low" | null | undefined
    >();
    expectTypeOf<Values<P, S>["Orphan"]>().toEqualTypeOf<null | undefined>();
    expectTypeOf<Snapshot<P, S>["Servings"]>().toEqualTypeOf<number | null>();

    // @ts-expect-error unknown option
    const badOption: Values<P, S> = { Status: "Nope" };
    // @ts-expect-error unknown field
    const badField: Values<P, S> = { Cuisine: "Thai" };
    // @ts-expect-error wrong kind
    const badKind: Values<P, S> = { Servings: "four" };
    expect([badOption, badField, badKind]).toHaveLength(3);
  });

  it("types issue field values by the owner schema", () => {
    const ok: IssueFieldValues<S> = {
      Priority: "Low",
      "Target date": "2026-11-01",
      Tags: ["vegan"],
    };
    expect(ok.Tags).toEqual(["vegan"]);
    expectTypeOf<IssueFieldValues<S>["Tags"]>().toEqualTypeOf<
      readonly ("vegan" | "quick")[] | null | undefined
    >();
    // @ts-expect-error unknown option
    const bad: IssueFieldValues<S> = { Priority: "Critical" };
    expect(bad).toBeDefined();
  });
});
