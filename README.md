# MCP Gateway

Agent-agnostic remote MCP gateway for Google Workspace tools, with a path for adding more backend
MCP servers behind one public `/mcp` endpoint.

The project currently packages:

- an `agentgateway` front door for remote MCP traffic and OAuth protected-resource metadata;
- a Bun/TypeScript Google Workspace MCP wrapper;
- per-user Google OAuth token storage with encrypted refresh tokens;
- a `gws` subprocess executor using `GOOGLE_WORKSPACE_CLI_TOKEN` per call;
- Docker Compose, Terraform, Ansible, and Kubernetes deployment templates;
- tests, linting, formatting, and CI wiring.

## Architecture

There are two credential hops:

- **HOP-1 client to gateway:** the MCP client presents a bearer token from an issuer configured for
  the gateway and wrapper, such as Google OIDC, Okta, Entra, or a purpose-built identity service.
- **HOP-2 wrapper to Google:** the wrapper uses a per-user Google refresh token to mint short-lived
  Google Workspace access tokens for tool execution.

The HOP-1 bearer token identifies the caller. It is never forwarded to Google. The wrapper injects
only the HOP-2 Google access token into `gws`.

```text
MCP client
  -> agentgateway /mcp
  -> google-workspace wrapper
  -> gws CLI
  -> Google Workspace APIs
```

## Google Workspace Tool Surface

The wrapper exposes:

- curated stable tools such as `google_drive_files_list`, `google_docs_get`, and
  `google_calendar_events_insert`;
- generated `gws_*` tools for the currently enabled Google Workspace families;
- `google_workspace_gws`, a guarded raw `gws` passthrough for advanced use.

The default public-safe surface is intentionally filtered to Drive, Gmail, Calendar, Docs, Sheets,
Slides, Tasks, limited Meet, and workflow helpers. Admin, Chat, Classroom, Cloud Platform,
contacts/directory, Forms, Keep, Groups, Apps Script, and user-profile-detail scopes are not exposed
by default.

See [docs/gws-generated-catalog.md](docs/gws-generated-catalog.md) and
[servers/google-workspace/README.md](servers/google-workspace/README.md).

## Local Development

Install dependencies:

```bash
bun install
```

Run all local checks:

```bash
bun run ci
bun run deploy:check
```

Run only tests:

```bash
bun test
```

Copy the compose environment template and fill in local values:

```bash
cp deploy/compose/.env.example deploy/compose/.env
```

Do not commit real `.env` files, OAuth client secrets, token encryption keys, Terraform state, or
cloud credentials.

## Deployment

Deployment templates are provided for:

- local and DEV-style Docker Compose under [deploy/compose](deploy/compose);
- a single AWS Compose host under [deploy/infra](deploy/infra);
- Kubernetes/Helm under [deploy/k8s](deploy/k8s).

The deployment assets are templates. Replace placeholder domains, AWS profile names, OAuth client
IDs, redirect URIs, and secret values for each environment.

## License

MIT. See [LICENSE](LICENSE).

Before making a mirror public or accepting outside contributions, still run the checks in
[docs/publication-checklist.md](docs/publication-checklist.md), especially the git-history secret
scan.
