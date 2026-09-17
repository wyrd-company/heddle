import { describe, expect, it } from "vitest";
import { collect, paginate, paginateRest } from "./paginate.js";

describe("paginate", () => {
  it("follows cursors until the last page and skips null nodes", async () => {
    const pages = new Map<string | undefined, { nodes: (string | null)[]; end: string | null }>([
      [undefined, { nodes: ["a", null, "b"], end: "c1" }],
      ["c1", { nodes: ["c"], end: null }],
    ]);
    const seen: (string | undefined)[] = [];
    const items = await collect(
      paginate(async (after) => {
        seen.push(after);
        const page = pages.get(after)!;
        return {
          nodes: page.nodes,
          pageInfo: { hasNextPage: page.end !== null, endCursor: page.end },
        };
      }),
    );
    expect(items).toEqual(["a", "b", "c"]);
    expect(seen).toEqual([undefined, "c1"]);
  });

  it("stops REST pagination on a short page", async () => {
    const calls: number[] = [];
    const items = await collect(
      paginateRest(async (page) => {
        calls.push(page);
        return page === 1 ? [1, 2] : [3];
      }, 2),
    );
    expect(items).toEqual([1, 2, 3]);
    expect(calls).toEqual([1, 2]);
  });
});
