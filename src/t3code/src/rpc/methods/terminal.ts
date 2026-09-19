// ---
// relationships:
//   implements:
//     - t3-code-client
//     - agent-tools
//     - node-types
// ---
import { z } from "zod";
import { defineMethod } from "../spec.js";
import {
  TerminalAttachInput,
  TerminalAttachStreamEvent,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "../../schemas/terminal.js";

export const terminalMethods = {
  "terminal.open": defineMethod({
    payload: TerminalOpenInput,
    success: TerminalSessionSnapshot,
    stream: false,
    scope: "terminal:operate",
  }),
  "terminal.attach": defineMethod({
    payload: TerminalAttachInput,
    success: TerminalAttachStreamEvent,
    stream: true,
    scope: "terminal:operate",
  }),
  "terminal.write": defineMethod({
    payload: TerminalWriteInput,
    success: z.void(),
    stream: false,
    scope: "terminal:operate",
  }),
  "terminal.resize": defineMethod({
    payload: TerminalResizeInput,
    success: z.void(),
    stream: false,
    scope: "terminal:operate",
  }),
  "terminal.close": defineMethod({
    payload: TerminalCloseInput,
    success: z.void(),
    stream: false,
    scope: "terminal:operate",
  }),
  subscribeTerminalEvents: defineMethod({
    payload: z.looseObject({}),
    success: TerminalEvent,
    stream: true,
    scope: "terminal:operate",
  }),
} as const;
