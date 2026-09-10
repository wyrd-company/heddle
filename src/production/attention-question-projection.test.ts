// ---
// relationships:
//   validates: heddle
// ---

import { describe, expect, it } from "vitest";

import {
  escalationQuestions,
  t3Questions,
} from "./attention-question-projection.js";

describe.each([escalationQuestions, t3Questions])(
  "harness question projection",
  (project) => {
    it("accepts an empty native question set", () => {
      expect(project([], "sample-attention")).toEqual([]);
    });
    it("preserves unbounded native question IDs", () => {
      const id = "reference-".repeat(30);
      expect(
        project(
          [{ id, question: "Enter a reference", options: [] }],
          "sample-attention",
        )[0]?.id,
      ).toBe(id);
    });
    it("preserves metadata and permits zero or one option with default cardinality", () => {
      expect(
        project(
          [
            { id: "reference", question: "Enter a reference", options: [] },
            {
              id: "ingredient",
              question: "Choose ingredients",
              header: "Ingredients",
              multiSelect: true,
              options: [
                { label: "First", description: "The first ingredient" },
              ],
            },
          ],
          "sample-attention",
        ),
      ).toEqual([
        {
          id: "reference",
          question: "Enter a reference",
          options: [],
          multiSelect: false,
        },
        {
          id: "ingredient",
          question: "Choose ingredients",
          header: "Ingredients",
          multiSelect: true,
          options: [{ label: "First", description: "The first ingredient" }],
        },
      ]);
    });

    it("rejects missing options", () => {
      expect(() =>
        project(
          [{ id: "reference", question: "Enter a reference" }],
          "sample-attention",
        ),
      ).toThrow("malformed options");
    });

    it("preserves repeated question IDs and option labels", () => {
      const question = {
        id: "route",
        question: "Choose a route",
        options: [{ label: "Shared" }, { label: "Shared" }],
      };

      expect(project([question, question], "sample-attention")).toEqual([
        { ...question, multiSelect: false },
        { ...question, multiSelect: false },
      ]);
    });
  },
);
