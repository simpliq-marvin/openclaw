type AgentOrchControlCommandName =
  | "halt"
  | "resume"
  | "unlatch"
  | "status"
  | "list"
  | "kill"
  | "close";

const KNOWN_COMMANDS = new Set<AgentOrchControlCommandName>([
  "halt",
  "resume",
  "unlatch",
  "status",
  "list",
  "kill",
  "close",
]);

export type ParsedAgentOrchControlCommand =
  | {
      kind: "command";
      name: AgentOrchControlCommandName;
      project: string;
      args: Record<string, string>;
      commandKey: string;
    }
  | { kind: "ignored" }
  | { kind: "invalid"; error: string };

function unescapeQuotedValue(value: string): string {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\(["'\\])/g, "$1");
}

function parseCommandArgs(
  body: string,
): { kind: "ok"; args: Record<string, string> } | { kind: "invalid"; error: string } {
  const args: Record<string, string> = {};
  const tokenPattern =
    /([a-zA-Z][a-zA-Z0-9_-]*)=(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s]+))/y;
  let cursor = 0;

  while (cursor < body.length) {
    while (cursor < body.length && /\s/.test(body[cursor] ?? "")) {
      cursor += 1;
    }
    if (cursor >= body.length) {
      break;
    }
    tokenPattern.lastIndex = cursor;
    const match = tokenPattern.exec(body);
    if (!match || match.index !== cursor) {
      const invalid = body.slice(cursor).split(/\s+/, 1)[0] ?? body.slice(cursor);
      return { kind: "invalid", error: `Invalid argument: ${invalid}` };
    }
    const key = match[1].trim();
    const value =
      match[2] != null
        ? unescapeQuotedValue(match[2])
        : match[3] != null
          ? unescapeQuotedValue(match[3])
          : (match[4] ?? "").trim();
    if (!value) {
      return { kind: "invalid", error: `Missing value for ${key}` };
    }
    args[key] = value;
    cursor = tokenPattern.lastIndex;
  }
  return { kind: "ok", args };
}

function formatCommandKey(name: string, project: string, args: Record<string, string>): string {
  const extra = Object.entries(args)
    .filter(([key]) => key !== "project")
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  return extra ? `${name} project=${project} ${extra}` : `${name} project=${project}`;
}

export function parseAgentOrchControlCommand(
  commandBodyNormalized: string,
): ParsedAgentOrchControlCommand {
  const raw = commandBodyNormalized.trim();
  if (!raw.startsWith("/oc")) {
    return { kind: "ignored" };
  }
  const match = raw.match(/^\/oc(?:\s+(.+))?$/i);
  if (!match) {
    return { kind: "invalid", error: 'Usage: /oc <cmd> project=<projectStem> [k="v"]' };
  }
  const body = match[1]?.trim();
  if (!body) {
    return { kind: "invalid", error: 'Usage: /oc <cmd> project=<projectStem> [k="v"]' };
  }
  const commandMatch = body.match(/^(\S+)(?:\s+([\s\S]+))?$/);
  if (!commandMatch) {
    return { kind: "invalid", error: 'Usage: /oc <cmd> project=<projectStem> [k="v"]' };
  }
  const commandName = commandMatch[1].trim().toLowerCase();
  if (!KNOWN_COMMANDS.has(commandName as AgentOrchControlCommandName)) {
    return { kind: "ignored" };
  }
  const argsBody = commandMatch[2]?.trim() ?? "";
  const parsedArgs = parseCommandArgs(argsBody);
  if (parsedArgs.kind === "invalid") {
    return parsedArgs;
  }
  const args = parsedArgs.args;
  const project = args.project?.trim();
  if (!project) {
    return { kind: "invalid", error: "Missing required project=<projectStem> argument." };
  }
  const commandKey = formatCommandKey(commandName, project, args);
  return {
    kind: "command",
    name: commandName as AgentOrchControlCommandName,
    project,
    args,
    commandKey,
  };
}
