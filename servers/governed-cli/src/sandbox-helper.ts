import { sandboxHelperEnvironment } from "./process-environment";
import { runSandboxHelper } from "./shim";

process.exitCode = await runSandboxHelper({
  argv0: process.argv0,
  args: process.argv.slice(2),
  env: sandboxHelperEnvironment(process.env),
});
