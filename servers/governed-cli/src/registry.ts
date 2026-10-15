import type { Hop1Identity } from "../../../shared/identity/hop1";
import type { ToolRegistry, ToolResult } from "../../../packages/wrapper-kit/src/mcp/registry";
import {
  parseTaskToolAuthorization,
  TASK_TOOL_DENIED_ERROR,
  TASK_TOOL_DENIED_MESSAGE,
  type TaskToolAuthorization,
  type TaskToolAuthorizationOptions,
} from "../../../packages/wrapper-kit/src/task-tool-authorization";
import type { CliDecisionCatalog, CommandClass } from "./catalog";
import { CommandRefusedError, type CommandClassifier } from "./classifier";
import { CliExecutionError, executeCli, type CliRunnerConfig } from "./executor";

export interface CliTarget {
  catalog: CliDecisionCatalog;
  classifier: CommandClassifier;
  runner: CliRunnerConfig;
}

export interface CreateCliRegistryOptions {
  identity: Hop1Identity;
  targets: readonly CliTarget[];
  taskToolAuthorization?: TaskToolAuthorizationOptions;
  execute?: typeof executeCli;
}

const TOOLS = [
  {
    name: "cli_list",
    description: "List governed command-line targets and approved command classes.",
    inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "cli_run",
    description: "Run an approved command as an argument vector without a shell.",
    inputSchema: {
      type: "object" as const,
      properties: {
        cli: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        timeout_seconds: { type: "integer", minimum: 1 },
      },
      required: ["cli", "args"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
];

export function createCliRegistry(options: CreateCliRegistryOptions): ToolRegistry {
  const targets = targetMap(options.targets);
  const authorization = parseTaskToolAuthorization(
    options.identity.claims,
    options.taskToolAuthorization,
  );
  const visibleTargets = () => listVisibleTargets(targets.values(), authorization);

  return {
    listTools: () => (visibleTargets().length > 0 ? TOOLS : []),
    supportsTool: (name) => TOOLS.some((tool) => tool.name === name),
    callTool: async (name, args) => {
      if (name === "cli_list") {
        const clis = visibleTargets();
        return clis.length > 0 ? result({ clis }) : taskDenied();
      }
      if (name !== "cli_run") return refused("tool is not supported");
      if (typeof args.cli !== "string" || !targets.has(args.cli)) {
        return refused("CLI target is not approved");
      }
      if (!Array.isArray(args.args) || !args.args.every((arg) => typeof arg === "string")) {
        return refused("args must be an array of strings");
      }
      if (args.timeout_seconds !== undefined && typeof args.timeout_seconds !== "number") {
        return refused("timeout_seconds must be an integer");
      }

      const target = targets.get(args.cli);
      if (!target) return refused("CLI target is not approved");
      try {
        const classified = target.classifier.classify(args.args);
        if (target.catalog.commands[classified.command]?.class !== classified.class) {
          return refused("classified command is absent from the decisions catalog");
        }
        if (!authorization.allows(grant(args.cli, classified.class))) return taskDenied();
        return result({
          ...(await (options.execute ?? executeCli)(
            target.runner,
            args.args,
            classified.class,
            args.timeout_seconds,
          )),
        });
      } catch (error) {
        if (error instanceof CommandRefusedError || error instanceof CliExecutionError) {
          return refused(error.message);
        }
        throw error;
      }
    },
  };
}

function targetMap(targets: readonly CliTarget[]): Map<string, CliTarget> {
  const mapped = new Map<string, CliTarget>();
  for (const target of targets) {
    if (mapped.has(target.catalog.cli))
      throw new Error(`Duplicate CLI target: ${target.catalog.cli}`);
    mapped.set(target.catalog.cli, target);
  }
  return mapped;
}

function listVisibleTargets(
  targets: Iterable<CliTarget>,
  authorization: TaskToolAuthorization,
): { cli: string; classes: CommandClass[] }[] {
  const visible: { cli: string; classes: CommandClass[] }[] = [];
  for (const target of targets) {
    const classes = [
      ...new Set(Object.values(target.catalog.commands).map((item) => item.class)),
    ].filter((commandClass) => authorization.allows(grant(target.catalog.cli, commandClass)));
    if (classes.length > 0) visible.push({ cli: target.catalog.cli, classes });
  }
  return visible;
}

function grant(cli: string, commandClass: CommandClass) {
  return { provider: "cli", resource: cli, action: commandClass };
}

function taskDenied(): ToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: TASK_TOOL_DENIED_MESSAGE }],
    structuredContent: { error: TASK_TOOL_DENIED_ERROR },
  };
}

function refused(message: string): ToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: { error: "cli_command_refused" },
  };
}

function result(value: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}
