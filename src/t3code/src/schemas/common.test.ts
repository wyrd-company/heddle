import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  forwardCompatibleArray,
  forwardCompatibleNullable,
  isUnknownVariant,
  taggedUnionWithUnknown,
} from "./common.js";

describe("taggedUnionWithUnknown", () => {
  const Shape = taggedUnionWithUnknown("kind", [
    z.looseObject({ kind: z.literal("circle"), radius: z.number() }),
    z.looseObject({ kind: z.enum(["square", "rect"]), side: z.number() }),
  ]);

  it("decodes a known member with its literal type", () => {
    const value = Shape.parse({ kind: "circle", radius: 2, extra: true });
    expect(value).toMatchObject({ kind: "circle", radius: 2, extra: true });
    expect(isUnknownVariant(value)).toBe(false);
  });

  it("decodes an unrecognised member as an unknown variant", () => {
    const value = Shape.parse({ kind: "hexagon", sides: 6 });
    expect(isUnknownVariant(value)).toBe(true);
    if (isUnknownVariant(value)) expect(value.raw).toEqual({ kind: "hexagon", sides: 6 });
  });

  it("still fails a known member that is malformed", () => {
    expect(Shape.safeParse({ kind: "circle", radius: "big" }).success).toBe(false);
    expect(Shape.safeParse({ kind: "rect" }).success).toBe(false);
  });
});

describe("forwardCompatibleArray", () => {
  it("drops elements that do not decode", () => {
    const List = forwardCompatibleArray(z.looseObject({ id: z.string() }));
    expect(List.parse([{ id: "a" }, { nope: 1 }, { id: "b" }])).toEqual([{ id: "a" }, { id: "b" }]);
  });
});

describe("forwardCompatibleNullable", () => {
  it("maps missing and unknown values to null", () => {
    const Mode = forwardCompatibleNullable(z.enum(["fast", "slow"]));
    expect(Mode.parse(undefined)).toBeNull();
    expect(Mode.parse("warp")).toBeNull();
    expect(Mode.parse("fast")).toBe("fast");
  });
});
