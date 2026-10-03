import { describe, expect, test } from "bun:test";

import {
  parseGenericToolCatalog,
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
    expect(parseGenericWrapperDescriptor(baseDescriptor).credential).toEqual({ mode: "none" });
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
          identity: { idField: "sub", emailField: "email" },
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
          identity: { idField: "sub", emailField: "email" },
        },
      }),
    ).toThrow("/oauth/search-provider/callback");
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
        identity: { idField: "sub", emailField: "email" },
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
  });
});
