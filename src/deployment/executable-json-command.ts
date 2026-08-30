// ---
// relationships:
//   implements: heddle
// ---

import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";

export type ExecutableJsonCommandConfiguration = {
  arguments: readonly string[];
  executable: string;
  timeoutMilliseconds: number;
};

type ExecutableJsonCommandInput = {
  configuration: ExecutableJsonCommandConfiguration;
  error: (message: string) => Error;
  label: string;
  request: unknown;
};

const maximumResponseBytes = 64 * 1024;
const forcedTerminationDelayMilliseconds = 50;

export const runExecutableJsonCommand = async (
  input: ExecutableJsonCommandInput,
): Promise<string> => {
  const request = `${JSON.stringify(input.request)}\n`;
  return new Promise<string>((resolve, reject) => {
    let child;
    try {
      child = spawn(
        input.configuration.executable,
        [...input.configuration.arguments],
        {
          shell: false,
          stdio: ["pipe", "pipe", "ignore"],
          windowsHide: true,
        },
      );
    } catch {
      reject(
        input.error(
          `${input.label} executable '${input.configuration.executable}' could not start`,
        ),
      );
      return;
    }

    const chunks: Buffer[] = [];
    let responseBytes = 0;
    let responseTooLarge = false;
    let inputFailed = false;
    let timedOut = false;
    let settled = false;
    let forcedTermination: ReturnType<typeof globalThis.setTimeout> | undefined;
    const timeout = globalThis.setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forcedTermination = globalThis.setTimeout(() => {
        child.kill("SIGKILL");
      }, forcedTerminationDelayMilliseconds);
    }, input.configuration.timeoutMilliseconds);
    const settle = (error: Error | undefined, output?: string): void => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      if (forcedTermination !== undefined) {
        globalThis.clearTimeout(forcedTermination);
      }
      if (error === undefined) resolve(output ?? "");
      else reject(error);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      responseBytes += chunk.length;
      if (responseBytes > maximumResponseBytes) {
        responseTooLarge = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
    });
    child.once("error", () => {
      settle(
        input.error(
          `${input.label} executable '${input.configuration.executable}' could not start`,
        ),
      );
    });
    child.once("close", (code, signal) => {
      if (timedOut) {
        settle(
          input.error(
            `${input.label} exceeded ${input.configuration.timeoutMilliseconds}ms`,
          ),
        );
        return;
      }
      if (responseTooLarge) {
        settle(
          input.error(
            `${input.label} response exceeded ${maximumResponseBytes} bytes`,
          ),
        );
        return;
      }
      if (inputFailed) {
        settle(
          input.error(`${input.label} did not accept its complete request`),
        );
        return;
      }
      if (signal !== null) {
        settle(input.error(`${input.label} terminated by signal ${signal}`));
        return;
      }
      if (code !== 0) {
        settle(
          input.error(`${input.label} exited with status ${code ?? "unknown"}`),
        );
        return;
      }
      settle(undefined, Buffer.concat(chunks).toString("utf8"));
    });
    child.stdin.on("error", () => {
      inputFailed = true;
    });
    child.stdin.end(request);
  });
};
