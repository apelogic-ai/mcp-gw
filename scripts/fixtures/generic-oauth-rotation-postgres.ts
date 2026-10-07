import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { Pool } from "pg";

import type { Hop1Identity } from "../../shared/identity/hop1";
import { runOAuthMigrations, loadOAuthMigrations } from "../../shared/oauth/migrate";
import { createPostgresQueryClient } from "../../shared/oauth/postgres-client";
import { SqlOAuthTokenStore } from "../../shared/oauth/sql-store";
import type { GenericOAuthCredentialDescriptor } from "../../servers/generic-wrapper/src/descriptor";
import { createGenericOAuthRuntimeConfig } from "../../servers/generic-wrapper/src/oauth";

const connectionString = process.env.TOKEN_STORE_DSN;
if (!connectionString) throw new Error("TOKEN_STORE_DSN is required");

const pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 1_500 });
const suffix = randomUUID();
const identity: Hop1Identity = {
  profile: "generic-oauth-rotation-postgres",
  issuer: `https://jira-rotation.example.com/${suffix}`,
  subject: suffix,
  email: `jira-rotation-${suffix}@example.com`,
  claims: {},
};
const scopes = [
  "read:jira-user",
  "read:jira:agent-interface",
  "write:jira:agent-interface",
  "search:jira:agent-interface",
  "offline_access",
];
const descriptor: GenericOAuthCredentialDescriptor = {
  mode: "per_user_oauth",
  providerId: "jira",
  authorizationUrl: "https://auth.atlassian.com/authorize",
  tokenUrl: "https://auth.atlassian.com/oauth/token",
  userInfoUrl: "https://api.atlassian.com/oauth/token/accessible-resources",
  redirectUri: "http://127.0.0.1:28080/oauth/jira/callback",
  scopes,
  clientIdEnv: "JIRA_OAUTH_CLIENT_ID",
  clientSecretEnv: "JIRA_OAUTH_CLIENT_SECRET",
  encryptionKeyEnv: "JIRA_TOKEN_ENCRYPTION_KEY",
  tokenStoreDsnEnv: "TOKEN_STORE_DSN",
  identity: {
    mode: "atlassian_jira_asserted_email",
    siteUrl: "https://example.atlassian.net",
  },
  authorizationParams: { audience: "api.atlassian.com", prompt: "consent" },
  tokenEndpointAuthMethod: "client_secret_post",
};
const encryptionKey = Buffer.alloc(32, 31).toString("base64");
const config = createGenericOAuthRuntimeConfig(descriptor, {
  JIRA_OAUTH_CLIENT_ID: "jira-client",
  JIRA_OAUTH_CLIENT_SECRET: "jira-secret",
  JIRA_TOKEN_ENCRYPTION_KEY: encryptionKey,
  TOKEN_STORE_DSN: connectionString,
});
let refreshCalls = 0;
const providerFetch = async (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const request =
    input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
  if (request.url === descriptor.tokenUrl) {
    refreshCalls += 1;
    assert.equal(request.method, "POST");
    const body = await request.text();
    assert.match(body, /grant_type=refresh_token/);
    assert.match(body, /client_id=jira-client/);
    assert.match(body, /client_secret=jira-secret/);
    await Bun.sleep(25);
    return Response.json({
      access_token: "jira-rotated-active",
      refresh_token: "jira-rotated-renewal",
      expires_in: 3600,
      scope: scopes.join(" "),
    });
  }
  if (request.url === descriptor.userInfoUrl) {
    return Response.json([{ id: "cloud-1", url: "https://example.atlassian.net" }]);
  }
  if (request.url === "https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/myself") {
    return Response.json({
      accountId: "account-1",
      emailAddress: identity.email,
      active: true,
    });
  }
  throw new Error(`Unexpected provider request: ${request.url}`);
};

try {
  await runOAuthMigrations({ connect: async () => pool.connect() }, await loadOAuthMigrations());
  const firstStore = new SqlOAuthTokenStore(createPostgresQueryClient(pool));
  const secondStore = new SqlOAuthTokenStore(createPostgresQueryClient(pool));
  const first = config.lifecycle(firstStore, providerFetch);
  const second = config.lifecycle(secondStore, providerFetch);

  await first.activateAuthorizedGeneration(identity, scopes, {
    credential: {
      activeCredential: "jira-expired-active",
      renewalCredential: "jira-original-renewal",
    },
    displayAccountIdentity: identity.email,
    providerAccount: { id: "account-1" },
    grantedScopes: scopes,
    activeCredentialExpiresAt: new Date(Date.now() - 1),
    validatedAt: new Date(),
  });

  const [firstToken, secondToken] = await Promise.all([
    first.getActiveCredential(identity, ["read:jira:agent-interface"]),
    second.getActiveCredential(identity, ["read:jira:agent-interface"]),
  ]);

  assert.equal(firstToken, "jira-rotated-active");
  assert.equal(secondToken, "jira-rotated-active");
  assert.equal(refreshCalls, 1);
  const connection = await pool.query(
    `
SELECT connection_generation, active_credential_present, renewal_credential_present,
       lifecycle_phase, provider_account_id
FROM oauth_accounts
WHERE provider = $1 AND hop1_issuer = $2 AND hop1_subject = $3
`,
    ["jira", identity.issuer, identity.subject],
  );
  assert.deepEqual(connection.rows, [
    {
      connection_generation: "2",
      active_credential_present: true,
      renewal_credential_present: true,
      lifecycle_phase: "connected",
      provider_account_id: "account-1",
    },
  ]);
  const custody = await pool.query(
    `
SELECT custody_state, count(*)::int AS count
FROM oauth_credential_generations
WHERE provider = $1 AND hop1_issuer = $2 AND hop1_subject = $3
GROUP BY custody_state
ORDER BY custody_state
`,
    ["jira", identity.issuer, identity.subject],
  );
  assert.deepEqual(custody.rows, [
    { custody_state: "active", count: 1 },
    { custody_state: "retired", count: 1 },
  ]);
  const retired = await pool.query(
    `
SELECT credential_envelope, encrypted_legacy_credential
FROM oauth_credential_generations
WHERE provider = $1 AND hop1_issuer = $2 AND hop1_subject = $3
  AND custody_state = 'retired'
`,
    ["jira", identity.issuer, identity.subject],
  );
  assert.deepEqual(retired.rows, [
    { credential_envelope: null, encrypted_legacy_credential: null },
  ]);
  process.stdout.write("Generic OAuth rotating refresh PostgreSQL regression passed.\n");
} finally {
  for (const table of [
    "oauth_credential_generations",
    "oauth_connection_authorizations",
    "oauth_accounts",
  ]) {
    await pool.query(
      `DELETE FROM ${table} WHERE provider = $1 AND hop1_issuer = $2 AND hop1_subject = $3`,
      ["jira", identity.issuer, identity.subject],
    );
  }
  await pool.end();
}
