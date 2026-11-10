import { readFileSync } from "node:fs";

type Environment = Readonly<Record<string, string | undefined>>;

const readOwnEnviron = (): Uint8Array => readFileSync("/proc/self/environ");

/**
 * The environment the sandbox helper reads its configuration from.
 *
 * A Bun standalone executable can start with an empty `process.env` under some process
 * supervisors (seccomp with no-new-privileges), although the kernel passed the environment and
 * `/proc/self/environ` still holds it. Only in that case the helper reads its own environ. An
 * unreadable environ yields an empty environment, so configuration still fails closed.
 */
export function sandboxHelperEnvironment(
  runtime: Environment,
  readEnviron: () => Uint8Array = readOwnEnviron,
): Environment {
  if (Object.keys(runtime).length > 0) return runtime;
  let environ: Uint8Array;
  try {
    environ = readEnviron();
  } catch {
    return {};
  }
  const env: Record<string, string> = {};
  for (const entry of new TextDecoder().decode(environ).split("\0")) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    env[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return env;
}
