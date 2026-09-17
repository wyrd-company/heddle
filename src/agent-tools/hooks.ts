// ---
// relationships:
//   implements: agent-tools
// ---
import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
export type Harness = "claude" | "codex";

export function hookSocketPath(): string {
  return join(
    process.env["HEDDLE_STATE_DIR"] ??
      join(
        process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state"),
        "heddle",
      ),
    "hooks.sock",
  );
}

/** Both native plugins send the harness identity unchanged to Heddle's writer. */
export async function runStopHook(
  _harness: Harness,
  input: string,
  socketPath = hookSocketPath(),
): Promise<Record<string, unknown>> {
  const event = JSON.parse(input) as Record<string, unknown>;
  if (
    event["hook_event_name"] !== "Stop" ||
    typeof event["session_id"] !== "string" ||
    !event["session_id"].length
  )
    throw new Error("Invalid Stop hook input");
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: "/hook/stop",
        method: "POST",
        headers: { "content-type": "application/json" },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("error", reject);
        response.on("end", () => {
          try {
            const value = JSON.parse(body) as Record<string, unknown>;
            if (response.statusCode !== 200)
              throw new Error(
                typeof value["error"] === "string"
                  ? value["error"]
                  : "Cannot resolve Heddle session",
              );
            resolve(value);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      },
    );
    req.on("error", (error: NodeJS.ErrnoException) => {
      // A reusable plugin is inert when Heddle is not running.
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolve({});
      else reject(error instanceof Error ? error : new Error(String(error)));
    });
    req.end(JSON.stringify({ session_id: event["session_id"] }));
  });
}

export async function hookCli(harness: Harness): Promise<number> {
  try {
    let input = "";
    for await (const chunk of process.stdin) input += String(chunk);
    console.log(JSON.stringify(await runStopHook(harness, input)));
    return 0;
  } catch (error) {
    console.error(
      `Heddle could not check the missing handoff: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }
}
