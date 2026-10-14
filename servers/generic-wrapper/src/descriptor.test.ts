import { describe, expect, test } from "bun:test";

import {
  parseGenericToolCatalog,
  parseGenericToolDecisions,
  parseGenericWrapperDescriptor,
  validateGenericWrapperConfiguration,
} from "./descriptor";

const baseDescriptor = {
  schemaVersion: "mcp-gateway.generic-wrapper/v1",
  name: "hosted-search",
  toolPrefix: "search",
  catalogPath: "/etc/mcp-gw/catalog.json",
  upstream: {
    transport: "http",
    url: "https://mcp.example.com/mcp",
  },
  credential: { mode: "none" },
};

describe("generic wrapper descriptor", () => {
  test("parses every supported credential and upstream mode without secret values", () => {
    const defaultDescriptor = parseGenericWrapperDescriptor(baseDescriptor);
    expect(defaultDescriptor.credential).toEqual({ mode: "none" });
    expect(defaultDescriptor.sessions).toEqual({
      maxTotal: 64,
      maxPerPrincipal: 4,
      idleTtlMs: 1_800_000,
    });
    expect(
      parseGenericWrapperDescriptor({
        ...baseDescriptor,
        credential: {
          mode: "static_secret",
          env: "UPSTREAM_API_KEY",
          header: "x-api-key",
        },
      }).credential,
    ).toEqual({ mode: "static_secret", env: "UPSTREAM_API_KEY", header: "x-api-key" });
    expect(
      parseGenericWrapperDescriptor({
        ...baseDescriptor,
        credential: {
          mode: "token_exchange",
          endpoint: "https://identity.example.com/oauth/token",
          audience: "https://mcp.example.com",
          clientIdEnv: "TOKEN_EXCHANGE_CLIENT_ID",
          clientSecretEnv: "TOKEN_EXCHANGE_CLIENT_SECRET",
        },
      }).credential.mode,
    ).toBe("token_exchange");
    expect(
      parseGenericWrapperDescriptor({
        ...baseDescriptor,
        lifecycleRoutes: true,
        credential: {
          mode: "per_user_oauth",
          providerId: "search-provider",
          authorizationUrl: "https://identity.example.com/oauth/authorize",
          tokenUrl: "https://identity.example.com/oauth/token",
          userInfoUrl: "https://identity.example.com/oauth/userinfo",
          redirectUri: "https://gateway.example.com/oauth/search-provider/callback",
          scopes: ["search.read"],
          clientIdEnv: "OAUTH_CLIENT_ID",
          clientSecretEnv: "OAUTH_CLIENT_SECRET",
          encryptionKeyEnv: "OAUTH_TOKEN_ENCRYPTION_KEY",
          tokenStoreDsnEnv: "TOKEN_STORE_DSN",
          identity: {
            idField: "sub",
            emailField: "email",
            emailVerifiedField: "email_verified",
          },
        },
      }).credential.mode,
    ).toBe("per_user_oauth");
    expect(
      parseGenericWrapperDescriptor({
        ...baseDescriptor,
        upstream: {
          transport: "stdio",
          command: "/app/bin/reference-mcp",
          args: ["--stdio"],
        },
      }).upstream,
    ).toEqual({
      transport: "stdio",
      command: "/app/bin/reference-mcp",
      args: ["--stdio"],
    });
  });

  test("parses bounded session limits and rejects an unfair quota", () => {
    expect(
      parseGenericWrapperDescriptor({
        ...baseDescriptor,
        sessions: { maxTotal: 20, maxPerPrincipal: 3, idleTtlMs: 60_000 },
      }).sessions,
    ).toEqual({ maxTotal: 20, maxPerPrincipal: 3, idleTtlMs: 60_000 });
    expect(() =>
      parseGenericWrapperDescriptor({
        ...baseDescriptor,
        sessions: { maxTotal: 2, maxPerPrincipal: 3 },
      }),
    ).toThrow("must not exceed");
  });

  test("rejects inline secrets and incomplete lifecycle configuration", () => {
    expect(() =>
      parseGenericWrapperDescriptor({
        ...baseDescriptor,
        credential: {
          mode: "static_secret",
          env: "UPSTREAM_API_KEY",
          header: "x-api-key",
          value: "must-not-be-inline",
        },
      }),
    ).toThrow("Unsupported credential field");
    expect(() =>
      parseGenericWrapperDescriptor({
        ...baseDescriptor,
        credential: {
          mode: "per_user_oauth",
          providerId: "search-provider",
        },
      }),
    ).toThrow("lifecycleRoutes=true");
    expect(() =>
      parseGenericWrapperDescriptor({
        ...baseDescriptor,
        credential: {
          mode: "token_exchange",
          endpoint: "https://identity.example.com/oauth/token",
        },
      }),
    ).toThrow("audience or credential.resource");
  });

  test("rejects credential-bearing URLs and a mismatched OAuth callback path", () => {
    expect(() =>
      parseGenericWrapperDescriptor({
        ...baseDescriptor,
        upstream: {
          transport: "http",
          url: "https://api-key@mcp.example.com/mcp",
        },
      }),
    ).toThrow("credentials");
    expect(() =>
      parseGenericWrapperDescriptor({
        ...baseDescriptor,
        lifecycleRoutes: true,
        credential: {
          mode: "per_user_oauth",
          providerId: "search-provider",
          authorizationUrl: "https://identity.example.com/oauth/authorize",
          tokenUrl: "https://identity.example.com/oauth/token",
          userInfoUrl: "https://identity.example.com/oauth/userinfo",
          redirectUri: "https://gateway.example.com/oauth/other-provider/callback",
          scopes: ["search.read"],
          clientIdEnv: "OAUTH_CLIENT_ID",
          clientSecretEnv: "OAUTH_CLIENT_SECRET",
          encryptionKeyEnv: "OAUTH_TOKEN_ENCRYPTION_KEY",
          tokenStoreDsnEnv: "TOKEN_STORE_DSN",
          identity: {
            idField: "sub",
            emailField: "email",
            emailVerifiedField: "email_verified",
          },
        },
      }),
    ).toThrow("/oauth/search-provider/callback");
    expect(() =>
      parseGenericWrapperDescriptor({
        ...baseDescriptor,
        lifecycleRoutes: true,
        credential: {
          mode: "per_user_oauth",
          providerId: "search-provider",
          authorizationUrl: "https://identity.example.com/oauth/authorize",
          tokenUrl: "https://identity.example.com/oauth/token",
          userInfoUrl: "https://identity.example.com/oauth/userinfo",
          redirectUri: "https://gateway.example.com/oauth/search-provider/callback",
          scopes: ["search.read"],
          clientIdEnv: "OAUTH_CLIENT_ID",
          clientSecretEnv: "OAUTH_CLIENT_SECRET",
          encryptionKeyEnv: "OAUTH_TOKEN_ENCRYPTION_KEY",
          tokenStoreDsnEnv: "TOKEN_STORE_DSN",
          identity: { idField: "sub", emailField: "email" },
        },
      }),
    ).toThrow("emailVerifiedField");
  });

  test("accepts the exact loopback OAuth callback used by local provider development", () => {
    const parsed = parseGenericWrapperDescriptor({
      ...baseDescriptor,
      lifecycleRoutes: true,
      credential: {
        mode: "per_user_oauth",
        providerId: "jira",
        authorizationUrl: "https://auth.atlassian.com/authorize",
        tokenUrl: "https://auth.atlassian.com/oauth/token",
        userInfoUrl: "https://api.atlassian.com/oauth/token/accessible-resources",
        redirectUri: "http://127.0.0.1:28080/oauth/jira/callback",
        scopes: ["read:jira-user", "read:jira:agent-interface", "offline_access"],
        clientIdEnv: "JIRA_OAUTH_CLIENT_ID",
        clientSecretEnv: "JIRA_OAUTH_CLIENT_SECRET",
        encryptionKeyEnv: "JIRA_TOKEN_ENCRYPTION_KEY",
        tokenStoreDsnEnv: "TOKEN_STORE_DSN",
        identity: {
          mode: "atlassian_jira_asserted_email",
          siteUrl: "https://example.atlassian.net",
        },
        tokenEndpointAuthMethod: "client_secret_post",
      },
    });

    expect(parsed.credential).toMatchObject({
      providerId: "jira",
      redirectUri: "http://127.0.0.1:28080/oauth/jira/callback",
      identity: {
        mode: "atlassian_jira_asserted_email",
        siteUrl: "https://example.atlassian.net",
      },
    });
    expect(() =>
      parseGenericWrapperDescriptor({
        ...baseDescriptor,
        lifecycleRoutes: true,
        credential: {
          ...parsed.credential,
          redirectUri: "http://localhost:28080/oauth/jira/callback",
        },
      }),
    ).toThrow("explicit loopback HTTP");
  });

  test("pins the Atlassian asserted-email mode to provider jira and its first-party resource API", () => {
    const credential = {
      mode: "per_user_oauth",
      providerId: "search-provider",
      authorizationUrl: "https://auth.atlassian.com/authorize",
      tokenUrl: "https://auth.atlassian.com/oauth/token",
      userInfoUrl: "https://identity.example.com/resources",
      redirectUri: "https://gateway.example.com/oauth/search-provider/callback",
      scopes: ["read:jira-user"],
      clientIdEnv: "OAUTH_CLIENT_ID",
      clientSecretEnv: "OAUTH_CLIENT_SECRET",
      encryptionKeyEnv: "OAUTH_TOKEN_ENCRYPTION_KEY",
      tokenStoreDsnEnv: "TOKEN_STORE_DSN",
      identity: {
        mode: "atlassian_jira_asserted_email",
        siteUrl: "https://example.atlassian.net",
      },
    };

    expect(() =>
      parseGenericWrapperDescriptor({
        ...baseDescriptor,
        lifecycleRoutes: true,
        credential,
      }),
    ).toThrow("providerId jira");
    expect(() =>
      parseGenericWrapperDescriptor({
        ...baseDescriptor,
        lifecycleRoutes: true,
        credential: {
          ...credential,
          providerId: "jira",
          redirectUri: "https://gateway.example.com/oauth/jira/callback",
        },
      }),
    ).toThrow("accessible-resources");
  });

  test("requires an explicit credential environment for credentialed stdio", () => {
    const descriptor = parseGenericWrapperDescriptor({
      ...baseDescriptor,
      upstream: {
        transport: "stdio",
        command: "/app/bin/reference-mcp",
        args: [],
      },
      credential: {
        mode: "static_secret",
        env: "UPSTREAM_API_KEY",
        header: "x-api-key",
      },
    });
    const catalog = parseGenericToolCatalog(
      {
        schemaVersion: "mcp-gateway.generic-catalog/v1",
        catalogId: "stdio-credential@1",
        tools: [
          {
            name: "query",
            description: "Query the stdio server.",
            inputSchema: { type: "object" },
            annotations: { readOnlyHint: true },
            grants: { actionClass: "read", scopes: [] },
          },
        ],
      },
      descriptor.toolPrefix,
    );

    expect(() => validateGenericWrapperConfiguration(descriptor, catalog)).toThrow("credentialEnv");
  });
});

describe("generic wrapper catalog", () => {
  test("pins prefixed tools and provider-resolved grant classification", () => {
    const catalog = parseGenericToolCatalog(
      {
        schemaVersion: "mcp-gateway.generic-catalog/v1",
        catalogId: "example-search@1",
        tools: [
          {
            name: "query",
            description: "Search public documents.",
            inputSchema: {
              type: "object",
              properties: { q: { type: "string" } },
              required: ["q"],
              additionalProperties: false,
            },
            annotations: { readOnlyHint: true },
            grants: {
              actionClass: "read",
              operation: "search.query",
              scopes: ["search.read"],
            },
          },
        ],
      },
      "search",
    );

    expect(catalog.catalogId).toBe("example-search@1");
    expect(catalog.tools[0]?.exposedName).toBe("search_query");
    expect(catalog.tools[0]?.upstreamName).toBe("query");
    expect(catalog.tools[0]?.grants).toEqual({
      actionClass: "read",
      operation: "search.query",
      scopes: ["search.read"],
    });
  });

  test("uses a stable alias without changing the upstream tool name", () => {
    const catalog = parseGenericToolCatalog(
      {
        schemaVersion: "mcp-gateway.generic-catalog/v1",
        catalogId: "jira@captured",
        tools: [
          {
            name: "searchJiraIssuesUsingJql",
            alias: "search_issues",
            description: "Search Jira issues with JQL.",
            inputSchema: { type: "object" },
            annotations: { readOnlyHint: true },
            grants: {
              actionClass: "read",
              operation: "jira.issue.search",
              scopes: ["search:jira:agent-interface"],
            },
          },
        ],
      },
      "jira",
    );

    expect(catalog.tools[0]).toMatchObject({
      upstreamName: "searchJiraIssuesUsingJql",
      exposedName: "jira_search_issues",
    });
  });

  test("parses live decisions without vendor descriptions or schemas", () => {
    const decisions = parseGenericToolDecisions(
      {
        schemaVersion: "mcp-gateway.generic-tool-decisions/v1",
        catalogId: "provider-live",
        tools: [
          {
            name: "getIssue",
            disposition: "include",
            alias: "get_issue",
            actionClass: "read",
            operation: "jira.issue.get",
            scopes: ["read:jira:agent-interface"],
          },
          { name: "deleteIssue", disposition: "exclude", reason: "delete" },
          {
            name: "editIssue",
            disposition: "include",
            alias: "edit_issue",
            actionClass: "write",
            operation: "jira.issue.edit",
            scopes: ["write:jira:agent-interface"],
          },
        ],
      },
      "jira",
      { actionClasses: ["read"] },
    );

    expect(decisions.mode).toBe("live");
    expect(decisions.decisions).toHaveLength(3);
    expect(decisions.tools).toEqual([
      {
        upstreamName: "getIssue",
        exposedName: "jira_get_issue",
        alias: "get_issue",
        disposition: "include",
        grants: {
          actionClass: "read",
          operation: "jira.issue.get",
          scopes: ["read:jira:agent-interface"],
        },
      },
    ]);
  });

  test("rejects duplicate exposed names and unclassified tools", () => {
    const tool = {
      name: "query",
      description: "Search.",
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
      grants: { actionClass: "read", operation: "search.query", scopes: [] },
    };
    expect(() =>
      parseGenericToolCatalog(
        {
          schemaVersion: "mcp-gateway.generic-catalog/v1",
          catalogId: "duplicate@1",
          tools: [tool, tool],
        },
        "search",
      ),
    ).toThrow("Duplicate catalog tool");
    expect(() =>
      parseGenericToolCatalog(
        {
          schemaVersion: "mcp-gateway.generic-catalog/v1",
          catalogId: "unclassified@1",
          tools: [{ ...tool, grants: undefined }],
        },
        "search",
      ),
    ).toThrow("grants");
  });

  test("reserves lifecycle helper names in an OAuth catalog", () => {
    const descriptor = parseGenericWrapperDescriptor({
      ...baseDescriptor,
      lifecycleRoutes: true,
      credential: {
        mode: "per_user_oauth",
        providerId: "search-provider",
        authorizationUrl: "https://identity.example.com/oauth/authorize",
        tokenUrl: "https://identity.example.com/oauth/token",
        userInfoUrl: "https://identity.example.com/oauth/userinfo",
        redirectUri: "https://gateway.example.com/oauth/search-provider/callback",
        scopes: ["search.read"],
        clientIdEnv: "OAUTH_CLIENT_ID",
        clientSecretEnv: "OAUTH_CLIENT_SECRET",
        encryptionKeyEnv: "OAUTH_TOKEN_ENCRYPTION_KEY",
        tokenStoreDsnEnv: "TOKEN_STORE_DSN",
        identity: {
          idField: "sub",
          emailField: "email",
          emailVerifiedField: "email_verified",
        },
      },
    });
    const catalog = parseGenericToolCatalog(
      {
        schemaVersion: "mcp-gateway.generic-catalog/v1",
        catalogId: "helper-collision@1",
        tools: [
          {
            name: "oauth_status",
            description: "Collides with the wrapper-owned lifecycle helper.",
            inputSchema: { type: "object" },
            annotations: { readOnlyHint: true },
            grants: { actionClass: "read", scopes: [] },
          },
        ],
      },
      descriptor.toolPrefix,
    );

    expect(() => validateGenericWrapperConfiguration(descriptor, catalog)).toThrow(
      "lifecycle helper",
    );

    const unavailableScopeCatalog = parseGenericToolCatalog(
      {
        schemaVersion: "mcp-gateway.generic-catalog/v1",
        catalogId: "missing-consent-scope@1",
        tools: [
          {
            name: "query",
            description: "Requires a scope the authorization request omits.",
            inputSchema: { type: "object" },
            annotations: { readOnlyHint: true },
            grants: { actionClass: "read", scopes: ["search.write"] },
          },
        ],
      },
      descriptor.toolPrefix,
    );
    expect(() => validateGenericWrapperConfiguration(descriptor, unavailableScopeCatalog)).toThrow(
      "search.write",
    );

    if (descriptor.credential.mode !== "per_user_oauth") {
      throw new Error("fixture must use per_user_oauth");
    }
    const oauthCredential = descriptor.credential;
    expect(() =>
      validateGenericWrapperConfiguration(
        {
          ...descriptor,
          credential: { ...oauthCredential, providerId: "google" },
        },
        catalog,
      ),
    ).toThrow("reserved");
  });
});
