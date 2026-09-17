// ---
// relationships:
//   implements:
//     - blueprint-authoring
//     - agent-tools
// ---
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
  ["validate", { usage: "Usage: heddle validate <path>" }],
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

export function runCli(arguments_: readonly string[], io: CliIo): number {
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

  if (commandArguments.length === 0 || commandName === "start") {
    io.error(command.usage);
    return 2;
  }

  io.error(`${command.usage}\n\nThis command is not implemented yet.`);
  return 2;
}
