// ---
// relationships:
//   implements:
//     - blueprint-authoring
//     - agent-tools
// ---
import type { ValidationOptions } from "./blueprints/types.js";
import { VALIDATION_RULES } from "./blueprints/rules.js";
import { validateBlueprintPath } from "./blueprints/validate.js";

export interface CliIo {
  error(message: string): void;
  output(message: string): void;
}

interface CommandHelp {
  readonly usage: string;
}

const commands = new Map<string, CommandHelp>([
  [
    "hook",
    {
      usage: "Usage: heddle hook <command>\n\nCommands:\n  stop <harness>",
    },
  ],
  [
    "skill",
    {
      usage:
        "Usage: heddle skill <command>\n\nCommands:\n  list\n  export <name> <directory>",
    },
  ],
  ["start", { usage: "Usage: heddle start" }],
  [
    "validate",
    {
      usage:
        "Usage: heddle validate [--json] [--check-requires-issue] <path>\n       heddle validate [--json] --rules",
    },
  ],
]);

const rootUsage = `Usage: heddle <command>

Commands:
  start       Start the service
  validate    Validate a blueprint file or repository
  skill       Work with embedded skills
  hook        Handle an agent harness hook

Run "heddle <command> --help" for command usage.`;

const isHelp = (value: string | undefined): boolean =>
  value === "--help" || value === "-h";

export function runCli(
  arguments_: readonly string[],
  io: CliIo,
  options: ValidationOptions = {},
): number {
  const [commandName, ...commandArguments] = arguments_;

  if (isHelp(commandName)) {
    io.output(rootUsage);
    return 0;
  }

  if (commandName === undefined) {
    io.error("A command is required.");
    io.error(rootUsage);
    return 2;
  }

  const command = commands.get(commandName);
  if (command === undefined) {
    io.error(`Unknown command: ${commandName}`);
    io.error(rootUsage);
    return 2;
  }

  if (isHelp(commandArguments[0])) {
    io.output(command.usage);
    return 0;
  }

  if (commandName === "validate") {
    return runValidate(commandArguments, io, command.usage, options);
  }

  if (commandArguments.length === 0 || commandName === "start") {
    io.error(command.usage);
    return 2;
  }

  io.error(`${command.usage}\n\nThis command is not implemented yet.`);
  return 2;
}

function runValidate(
  arguments_: readonly string[],
  io: CliIo,
  usage: string,
  options: ValidationOptions,
): number {
  const json = arguments_.includes("--json");
  const listRules = arguments_.includes("--rules");
  const checkRequiresIssue = arguments_.includes("--check-requires-issue");
  const unknownOptions = arguments_.filter(
    (argument) =>
      argument.startsWith("-") &&
      !["--json", "--rules", "--check-requires-issue"].includes(argument),
  );
  const paths = arguments_.filter((argument) => !argument.startsWith("-"));

  if (
    unknownOptions.length > 0 ||
    (listRules ? paths.length > 0 : paths.length !== 1)
  ) {
    io.error(usage);
    return 2;
  }

  if (listRules) {
    io.output(
      json
        ? JSON.stringify(VALIDATION_RULES, undefined, 2)
        : VALIDATION_RULES.map(
            (rule) => `${rule.name}\t${rule.description}`,
          ).join("\n"),
    );
    return 0;
  }

  const path = paths[0];
  if (path === undefined) {
    io.error(usage);
    return 2;
  }
  const findings = validateBlueprintPath(path, {
    ...options,
    checkRequiresIssue,
  });
  if (json) {
    io.output(JSON.stringify(findings, undefined, 2));
  } else if (findings.length === 0) {
    io.output(`Validated ${path}: no findings.`);
  } else {
    for (const item of findings) {
      io.error(`${item.file}:${item.node} [${item.rule}] ${item.message}`);
    }
  }
  return findings.length === 0 ? 0 : 1;
}
