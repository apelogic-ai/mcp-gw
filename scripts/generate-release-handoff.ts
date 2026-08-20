import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ReleaseHandoffOptions {
  artifactsDirectory: string;
  outputPath: string;
  owner: string;
  version: string;
}

const digestPattern = /^sha256:[a-f0-9]{64}$/;

export async function generateReleaseHandoff(options: ReleaseHandoffOptions): Promise<void> {
  const digests = {
    agentgateway: await readDigest(options.artifactsDirectory, "agentgateway"),
    googleWorkspace: await readDigest(options.artifactsDirectory, "google-workspace"),
    githubWrapper: await readDigest(options.artifactsDirectory, "github-wrapper"),
    chart: await readDigest(options.artifactsDirectory, "helm-chart"),
  };
  const registry = `ghcr.io/${options.owner}`;
  const chart = `oci://${registry}/charts/mcp-gateway`;

  const handoff = `# MCP Gateway v${options.version} Release Handoff

## OCI Chart

- Coordinate: \`${chart}\`
- Version: \`${options.version}\`
- Digest: \`${digests.chart}\`

\`\`\`bash
helm upgrade --install mcp-gateway ${chart} \\
  --version ${options.version} \\
  --values private-values.yaml
\`\`\`

## First-Party Images

| Component | Immutable image |
| --- | --- |
| agentgateway | \`${registry}/mcp-gw-agentgateway@${digests.agentgateway}\` |
| Google Workspace wrapper | \`${registry}/mcp-gw-google-workspace@${digests.googleWorkspace}\` |
| GitHub wrapper | \`${registry}/mcp-gw-github-wrapper@${digests.githubWrapper}\` |

The chart also references the separately maintained official GitHub MCP Server image. Pin or mirror
that image by digest in the private values overlay.

The optional \`dbMcp\` adapter is externally supplied. Set its image repository and digest in the
private values overlay before enabling it.

## Runtime Contract

- agentgateway: TCP \`8080\`, public MCP path \`/mcp\`.
- Google Workspace wrapper: TCP \`8080\`, internal MCP path \`/mcp\`.
- GitHub wrapper: TCP \`8080\`, internal MCP path \`/mcp\`.
- Official GitHub MCP Server: TCP \`8082\`, internal MCP path \`/mcp\`.
- Default Kubernetes Services are \`ClusterIP\`; ingress is opt-in.
- Every workload has configurable liveness and readiness probes under its \`probes\` values.

## Existing Secret Keys

The chart creates no provider credentials. When the corresponding adapter is enabled, reference an
existing Kubernetes Secret containing these environment-variable keys:

- Google Workspace: \`TOKEN_STORE_DSN\`, \`GOOGLE_OAUTH_CLIENT_ID\`,
  \`GOOGLE_OAUTH_CLIENT_SECRET\`, \`GOOGLE_OAUTH_REDIRECT_URI\`,
  \`GOOGLE_TOKEN_ENCRYPTION_KEY\`.
- GitHub: \`TOKEN_STORE_DSN\`, \`GITHUB_OAUTH_CLIENT_ID\`,
  \`GITHUB_OAUTH_CLIENT_SECRET\`, \`GITHUB_OAUTH_REDIRECT_URI\`,
  \`GITHUB_TOKEN_ENCRYPTION_KEY\`.
- Issuer introspection credentials: any key selected by each
  \`hop1.issuers[].introspection.credentialSecretKeyRef\`.

## Authorization Broker Capability Contract

This chart and Google Workspace wrapper include the optional public OAuth authorization broker.
The broker is disabled by default. Its deployment coordinates are environment-specific,
GitOps-owned values rather than release constants; this handoff deliberately contains no deployed
issuer, resource, callback, Secret name, or key ID.

The typed chart entry point is \`googleWorkspace.authorizationBroker.enabled\`. When enabled, GitOps
owns these non-secret public coordinates and policy values:

- \`googleWorkspace.authorizationBroker.issuer\`: canonical public authorization-server issuer.
- \`googleWorkspace.authorizationBroker.resource\`: exact canonical MCP resource and token audience.
- \`googleWorkspace.authorizationBroker.googleCallbackUri\`: upstream Google broker callback on the
  issuer origin.
- \`googleWorkspace.authorizationBroker.scopes\`: broker scope allowlist.
- \`googleWorkspace.authorizationBroker.activeSigningKid\`: non-secret active signing-key ID.
- \`googleWorkspace.authorizationBroker.staticClients\`: immutable public-client registrations.
- \`googleWorkspace.authorizationBroker.dcr.enabled\`: constrained DCR mode switch.

Public routes are derived, not separately configured. For an issuer whose pathname is
\`<issuer-path>\`, RFC 8414 metadata is served at
\`/.well-known/oauth-authorization-server<issuer-path>\`; authorization, token, JWKS, and optional
registration routes are \`<issuer-path>/authorize\`, \`<issuer-path>/token\`,
\`<issuer-path>/.well-known/jwks.json\`, and \`<issuer-path>/register\`. Protected-resource metadata
inserts \`/.well-known/oauth-protected-resource\` before the exact resource pathname. The Google
callback is the exact pathname from \`googleCallbackUri\`. The MCP resource and its protected-resource
metadata route through AgentGateway; the exact broker routes reach the Google wrapper.

Choose one reviewed registration mode:

- **DCR-enabled mode:** set \`googleWorkspace.authorizationBroker.dcr.enabled=true\`; constrained
  public-client registration is advertised and \`/register\` is exposed. Authorization code,
  \`token_endpoint_auth_method=none\`, PKCE S256, exact redirect persistence, and configured bounds
  remain mandatory.
- **static-only mode:** keep DCR disabled and populate
  \`googleWorkspace.authorizationBroker.staticClients\`; no registration endpoint is advertised or
  routed. Static clients remain immutable and receive no secret.

Signing material is file-only. GitOps supplies an existing Secret reference through
\`googleWorkspace.authorizationBroker.signingKeyring.secretKeyRef.name\` and
\`googleWorkspace.authorizationBroker.signingKeyring.secretKeyRef.key\`. The selected value is a
JWKS object with a \`"keys"\` array. The JWK selected by \`activeSigningKid\` must be a private RSA
\`RS256\`, \`use=sig\` key; rotation overlap may include prior public RSA verification JWKs with
distinct \`kid\` values. The chart projects only the selected Secret key, read-only with mode \`0440\`,
as \`/var/run/secrets/mcp-gateway/broker/signing-jwks.json\` and sets
\`MCP_BROKER_SIGNING_JWKS_FILE\` to that fixed path. Never put the JWKS payload in values, rendered
environment variables, or this handoff.

Repository protocol fixtures provide tested-client evidence for discovery, authorization code,
PKCE, constrained DCR, static registration, and renewal-by-reauthorization. That evidence proves the
product protocol contract; it does not establish compatibility with any named third-party client or
version. A deployment may claim such compatibility only with separate exact-version journey
evidence. The first broker release issues no public refresh token, confidential-client credential,
or provider token to the MCP client.

## Supply-Chain Evidence

This GitHub Release includes an SPDX JSON SBOM, a JSON vulnerability report, and a digest file for
each first-party image. GitHub build-provenance attestations are attached to each image digest and to
the OCI chart digest.
`;

  await writeFile(options.outputPath, handoff);
}

async function readDigest(directory: string, component: string): Promise<string> {
  const digest = (await readFile(join(directory, `${component}.digest`), "utf8")).trim();
  if (!digestPattern.test(digest)) {
    throw new Error(`Invalid ${component} digest: ${digest}`);
  }
  return digest;
}

function parseArgs(args: string[]): ReleaseHandoffOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error("Expected --version, --owner, --artifacts, and --output arguments");
    }
    values.set(key, value);
  }

  const version = values.get("--version");
  const owner = values.get("--owner");
  const artifactsDirectory = values.get("--artifacts");
  const outputPath = values.get("--output");
  if (!version || !owner || !artifactsDirectory || !outputPath) {
    throw new Error("Expected --version, --owner, --artifacts, and --output arguments");
  }
  return { artifactsDirectory, outputPath, owner, version };
}

if (import.meta.main) {
  generateReleaseHandoff(parseArgs(process.argv.slice(2))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
