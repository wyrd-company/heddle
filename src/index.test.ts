import { describe, expect, it } from "vitest";

import {
  console,
  controlPlane,
  createConsoleServer,
  engine,
  mcpServer,
  pacing,
  reconciler,
} from "./index.js";

describe("service package layout", () => {
  it("exports each architectural boundary", () => {
    expect({
      console,
      controlPlane,
      engine,
      mcpServer,
      pacing,
      reconciler,
    }).toEqual({
      console: "console",
      controlPlane: "control-plane",
      engine: "engine",
      mcpServer: "mcp-server",
      pacing: "pacing",
      reconciler: "reconciler",
    });
    expect(createConsoleServer).toBeTypeOf("function");
  });
});
