import { CommandRefusedError, type ClassifiedCommand, type CommandClassifier } from "./classifier";
import type { CliPack, CliPackFlags } from "./pack";

const FORBIDDEN_FLAGS = new Set([
  "--as",
  "--as-group",
  "--as-uid",
  "--token",
  "--server",
  "--kubeconfig",
  "--context",
  "--cluster",
  "--user",
  "--certificate-authority",
  "--insecure-skip-tls-verify",
  "--raw",
  "--filename",
  "-f",
]);

export function createKubectlClassifier(pack: CliPack): CommandClassifier {
  return { classify: (args) => classifyKubectl(pack, args) };
}

export function classifyKubectl(pack: CliPack, args: readonly string[]): ClassifiedCommand {
  let operation: string | undefined;
  let operationConfig: CliPack["operations"][string] | undefined;
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) refuse("kubectl argument is missing");
    if (argument === "--") refuse("kubectl argument separators are not approved");
    const flag = argument.startsWith("-") ? argument.split("=", 1)[0] : undefined;
    if (flag && FORBIDDEN_FLAGS.has(flag)) refuse(`kubectl flag ${flag} is not approved`);

    if (!operation && !flag) {
      operationConfig = pack.operations[argument];
      if (!operationConfig) refuse("kubectl subcommand is not approved");
      operation = argument;
      continue;
    }
    if (!operationConfig && !flag) refuse("kubectl subcommand is not approved");

    if (flag) {
      const flags = operationConfig?.flags ?? globalFlags(pack);
      index = consumeFlag(pack, flags, args, index, argument, flag);
    } else {
      positionals.push(argument);
    }
  }

  if (!operation || !operationConfig) refuse("kubectl subcommand is required");
  if (positionals.length === 0) refuse(`kubectl ${operation} requires a resource`);
  if (operation === "logs" && positionals.length !== 1) {
    refuse("kubectl logs accepts one workload argument");
  }

  const resource = positionals[0];
  if (!resource) refuse(`kubectl ${operation} requires a resource`);
  const secret =
    pack.secretOverlay.operations.has(operation) &&
    positionals.some((value) =>
      resourceNames(value).some((name) => pack.secretOverlay.resources.has(name)),
    );
  const command = secret ? `${operation}:secret` : operation;
  const decision = pack.catalog.commands[command];
  if (!decision) refuse("kubectl operation has no catalog decision");
  return { command, class: decision.class };
}

function consumeFlag(
  pack: CliPack,
  flags: CliPackFlags,
  args: readonly string[],
  index: number,
  argument: string,
  flag: string,
): number {
  const inline = argument.includes("=") ? argument.slice(argument.indexOf("=") + 1) : undefined;
  if (flags.boolean.includes(flag)) {
    if (inline !== undefined) refuse(`kubectl flag ${flag} does not take a value`);
    return index;
  }
  const output = flags.output.includes(flag);
  if (!output && !flags.value.includes(flag)) refuse(`kubectl flag ${flag} is not approved`);
  const value = inline ?? args[index + 1];
  if (!value || (inline === undefined && value.startsWith("-"))) {
    refuse(`kubectl flag ${flag} requires a value`);
  }
  if (output && !pack.outputFormats.has(value)) refuse("kubectl output format is not approved");
  return inline === undefined ? index + 1 : index;
}

function globalFlags(pack: CliPack): CliPackFlags {
  const value = new Set<string>();
  const boolean = new Set<string>();
  for (const operation of Object.values(pack.operations)) {
    for (const flag of operation.flags.value) {
      if (flag === "--namespace" || flag === "-n") value.add(flag);
    }
    for (const flag of operation.flags.boolean) {
      if (flag === "--all-namespaces" || flag === "-A") boolean.add(flag);
    }
  }
  return { value: [...value], boolean: [...boolean], output: [] };
}

function resourceNames(value: string): string[] {
  return value
    .split(",")
    .map((resource) => (resource.split("/", 1)[0]?.split(".", 1)[0] ?? "").toLowerCase());
}

function refuse(message: string): never {
  throw new CommandRefusedError(message);
}
