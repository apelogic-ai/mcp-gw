import type { Hop1Identity } from "../../../shared/identity/hop1";
import { createAuthenticatedMcpHttpHandler } from "../../../packages/wrapper-kit/src/mcp/authenticated-http";
import type { TaskToolAuthorizationOptions } from "../../../packages/wrapper-kit/src/task-tool-authorization";
import { createCliRegistry, type CliTarget } from "./registry";

export interface CreateGovernedCliHandlerOptions {
  authenticate(token: string): Promise<Hop1Identity>;
  targets: readonly CliTarget[];
  taskToolAuthorization?: TaskToolAuthorizationOptions;
}

export function createGovernedCliHandler(
  options: CreateGovernedCliHandlerOptions,
): (request: Request) => Promise<Response> {
  return createAuthenticatedMcpHttpHandler({
    authenticate: (token) => options.authenticate(token),
    registryFor: (identity) =>
      createCliRegistry({
        identity,
        targets: options.targets,
        taskToolAuthorization: options.taskToolAuthorization,
      }),
    serverInfo: { name: "governed-cli", version: "0.1.0" },
  });
}
