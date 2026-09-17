import { describe, expect, it } from "vitest";
import { formatIssueRef, parseIssueRef, parseRepoRef } from "./refs.js";
import { GitHubError } from "./transport/errors.js";

describe("refs", () => {
  it("parses string and object repository references", () => {
    expect(parseRepoRef("pantry-labs/recipes")).toEqual({ owner: "pantry-labs", repo: "recipes" });
    expect(parseRepoRef({ owner: "pantry-labs", repo: "recipes" })).toEqual({
      owner: "pantry-labs",
      repo: "recipes",
    });
  });

  it("parses issue references and formats them back", () => {
    const coords = parseIssueRef("pantry-labs/recipes#42");
    expect(coords).toEqual({ owner: "pantry-labs", repo: "recipes", number: 42 });
    expect(formatIssueRef(coords)).toBe("pantry-labs/recipes#42");
  });

  it("rejects malformed references with a VALIDATION error", () => {
    expect(() => parseRepoRef("recipes" as never)).toThrow(GitHubError);
    expect(() => parseIssueRef("pantry-labs/recipes" as never)).toThrowError(
      expect.objectContaining({ code: "VALIDATION" }),
    );
  });
});
