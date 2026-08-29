import { describe, expect, it } from "vitest";

import {
  console,
  controlPlane,
  engine,
  mcpServer,
  reconciler,
} from "./index.js";

describe("service package layout", () => {
  it("exports each architectural boundary", () => {
    expect({ console, controlPlane, engine, mcpServer, reconciler }).toEqual({
      console: "console",
      controlPlane: "control-plane",
      engine: "engine",
      mcpServer: "mcp-server",
      reconciler: "reconciler",
    });
  });
});
