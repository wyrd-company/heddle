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

    it("rejects missing options and repeated question IDs", () => {
      expect(() =>
        project(
          [{ id: "reference", question: "Enter a reference" }],
          "sample-attention",
        ),
      ).toThrow("malformed options");
      const question = {
        id: "reference",
        question: "Enter a reference",
        options: [],
      };
      expect(() => project([question, question], "sample-attention")).toThrow(
        "repeats question",
      );
    });
  },
);
