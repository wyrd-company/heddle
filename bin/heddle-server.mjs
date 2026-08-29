#!/usr/bin/env node

// ---
// relationships:
//   implements: heddle
// ---

import process from "node:process";

import { startHeddleServerFromEnvironment } from "../dist/deployment/server.js";

const service = await startHeddleServerFromEnvironment(process.env);

const stop = async () => {
  await service.close();
  process.exitCode = 0;
};

process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
