import { describe, expect, test } from "bun:test";

import { OAuthBrokerError } from "../../../../shared/oauth/authorization-broker";
import { ConstrainedDcrError } from "../../../../shared/oauth/dcr";
import { createAuthorizationServerRouteHandler } from "./authorization-routes";

const issuer = "https://auth.example.com";
const resource = "https://mcp.example.com/mcp";

describe("authorization-server HTTP routes", () => {
  test("publishes coherent metadata and advertises registration only when enabled", async () => {
    const withoutDcr = createAuthorizationServerRouteHandler({ broker: brokerStub() });
    const authorization = await withoutDcr(
      new Request(`${issuer}/.well-known/oauth-authorization-server`),
    );
    expect(await authorization.json()).toEqual({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });

    const protectedResource = await withoutDcr(
      new Request(`${issuer}/.well-known/oauth-protected-resource/mcp`),
    );
    expect(await protectedResource.json()).toEqual({
      resource,
      authorization_servers: [issuer],
      bearer_methods_supported: ["header"],
    });

    const withDcr = createAuthorizationServerRouteHandler({
      broker: brokerStub(),
      registration: registrationStub(),
      registrationRateLimitKey: () => "ip:192.0.2.1",
    });
    const enabled = await withDcr(new Request(`${issuer}/.well-known/oauth-authorization-server`));
    expect(await enabled.json()).toMatchObject({ registration_endpoint: `${issuer}/register` });
  });

  test("publishes only public broker verification material", async () => {
    const handler = createAuthorizationServerRouteHandler({ broker: brokerStub() });
    const response = await handler(new Request(`${issuer}/.well-known/jwks.json`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      keys: [{ kty: "RSA", kid: "active", alg: "RS256", use: "sig", n: "public", e: "AQAB" }],
    });
    expect(response.headers.get("cache-control")).toContain("public");
  });

  test("shows the client and exact redirect before continuing to Google", async () => {
    const handler = createAuthorizationServerRouteHandler({ broker: brokerStub() });
    const response = await handler(
      new Request(
        `${issuer}/authorize?response_type=code&client_id=client%3Cunsafe%3E&redirect_uri=${encodeURIComponent("https://client.example/callback?a=1&b=2")}&resource=${encodeURIComponent(resource)}&scope=mcp&code_challenge=${"A".repeat(43)}&code_challenge_method=S256&state=opaque-client-state`,
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const page = await response.text();
    expect(page).toContain("Client &lt;unsafe&gt;");
    expect(page).toContain("client&lt;unsafe&gt;");
    expect(page).toContain("https://client.example/about?x=1&amp;y=2");
    expect(page).toContain("Redirect origin: <code>https://client.example</code>");
    expect(page).toContain("https://client.example/callback?a=1&amp;b=2");
    expect(page).toContain("Continue with Google");
    expect(page).toContain("https://accounts.google.com/o/oauth2/v2/auth?");
    expect(page).not.toContain("client<unsafe>");
    expect(page).not.toContain("Client <unsafe>");
    expect(response.headers.get("content-security-policy")).toBeString();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("round-trips Google completion and denial through client redirects", async () => {
    const handler = createAuthorizationServerRouteHandler({ broker: brokerStub() });
    const completed = await handler(
      new Request(`${issuer}/oauth/google/broker/callback?code=google-code&state=broker-state`),
    );
    expect(completed.status).toBe(302);
    expect(completed.headers.get("location")).toBe(
      "https://client.example/callback?code=broker-code&state=opaque-client-state",
    );

    const denied = await handler(
      new Request(`${issuer}/oauth/google/broker/callback?error=access_denied&state=broker-state`),
    );
    expect(denied.status).toBe(302);
    expect(denied.headers.get("location")).toBe(
      "https://client.example/callback?error=access_denied&state=opaque-client-state",
    );
  });

  test("redirects validated authorization and upstream failures with the original client state", async () => {
    const authorizationFailure = new URL("https://client.example/callback");
    authorizationFailure.searchParams.set("error", "invalid_scope");
    authorizationFailure.searchParams.set("error_description", "scope is not registered");
    authorizationFailure.searchParams.set("state", "opaque-client-state");
    const upstreamFailure = new URL("https://client.example/callback");
    upstreamFailure.searchParams.set("error", "server_error");
    upstreamFailure.searchParams.set("error_description", "Upstream identity verification failed");
    upstreamFailure.searchParams.set("state", "opaque-client-state");
    const handler = createAuthorizationServerRouteHandler({
      broker: {
        ...brokerStub(),
        beginAuthorization: () =>
          Promise.reject(
            new OAuthBrokerError(
              "invalid_scope",
              "scope is not registered",
              authorizationFailure.toString(),
            ),
          ),
        completeGoogleAuthorization: () =>
          Promise.reject(
            new OAuthBrokerError(
              "server_error",
              "Upstream identity verification failed",
              upstreamFailure.toString(),
            ),
          ),
      },
    });

    const authorization = await handler(
      new Request(
        `${issuer}/authorize?client_id=client&redirect_uri=${encodeURIComponent("https://client.example/callback")}&state=opaque-client-state`,
      ),
    );
    expect(authorization.status).toBe(302);
    expect(authorization.headers.get("location")).toBe(authorizationFailure.toString());
    const callback = await handler(
      new Request(`${issuer}/oauth/google/broker/callback?code=bad&state=broker-state`),
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(upstreamFailure.toString());
  });

  test("serves every advertised endpoint for pathful issuer and resource configurations", async () => {
    const tenantIssuer = `${issuer}/tenant`;
    const tenantResource = "https://mcp.example.com/tenant/mcp";
    const tenantBroker = {
      ...brokerStub(),
      authorizationServerMetadata: () => ({
        issuer: tenantIssuer,
        authorization_endpoint: `${tenantIssuer}/authorize`,
        token_endpoint: `${tenantIssuer}/token`,
        jwks_uri: `${tenantIssuer}/.well-known/jwks.json`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      }),
      protectedResourceMetadata: () => ({
        resource: tenantResource,
        authorization_servers: [tenantIssuer],
        bearer_methods_supported: ["header"],
      }),
    };
    const handler = createAuthorizationServerRouteHandler({
      broker: tenantBroker,
      registration: registrationStub(),
      googleCallbackUri: `${tenantIssuer}/custom-callback`,
      registrationRateLimitKey: () => "ip:192.0.2.1",
    });

    expect(
      await handler(new Request(`${issuer}/.well-known/oauth-authorization-server/tenant`)),
    ).toMatchObject({ status: 200 });
    expect(
      await handler(
        new Request("https://mcp.example.com/.well-known/oauth-protected-resource/tenant/mcp"),
      ),
    ).toMatchObject({ status: 200 });
    expect(await handler(new Request(`${tenantIssuer}/.well-known/jwks.json`))).toMatchObject({
      status: 200,
    });
    expect(
      await handler(
        new Request(
          `${tenantIssuer}/authorize?client_id=client&redirect_uri=${encodeURIComponent("https://client.example/callback")}`,
        ),
      ),
    ).toMatchObject({ status: 200 });
    expect(
      await handler(
        new Request(`${tenantIssuer}/custom-callback?code=google-code&state=broker-state`),
      ),
    ).toMatchObject({ status: 302 });
    expect(
      await handler(
        new Request(`${tenantIssuer}/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
        { remoteAddress: "192.0.2.1" },
      ),
    ).toMatchObject({ status: 201 });
    expect(
      await handler(new Request(`${issuer}/.well-known/oauth-authorization-server`)),
    ).toMatchObject({ status: 404 });
  });

  test("exchanges a broker code without exposing Google material or refresh credentials", async () => {
    const handler = createAuthorizationServerRouteHandler({ broker: brokerStub() });
    const response = await handler(
      new Request(`${issuer}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "broker-code",
          client_id: "client",
          redirect_uri: "https://client.example/callback",
          resource,
          code_verifier: "v".repeat(64),
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      access_token: "broker-access-token",
      token_type: "Bearer",
      expires_in: 300,
      scope: "mcp",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
  });

  test.each([
    ["HTTP Basic", { authorization: "Basic cHVibGljOmludmVudGVk" }, {}, 401, 'Basic realm="token"'],
    [
      "HTTP Bearer",
      { authorization: "Bearer resource-access-token" },
      {},
      401,
      'Bearer realm="token"',
    ],
    ["client_secret_post", {}, { client_secret: "invented-secret" }, 400, null],
    ["client assertion", {}, { client_assertion: "invented-assertion" }, 400, null],
    [
      "client assertion type",
      {},
      { client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" },
      400,
      null,
    ],
    ["declared auth method", {}, { token_endpoint_auth_method: "private_key_jwt" }, 400, null],
  ])(
    "rejects %s credentials because the token endpoint supports public auth method none",
    async (_label, extraHeaders, extraForm, expectedStatus, expectedChallenge) => {
      let exchangeCalled = false;
      const handler = createAuthorizationServerRouteHandler({
        broker: {
          ...brokerStub(),
          exchangeAuthorizationCode: () => {
            exchangeCalled = true;
            return Promise.resolve({
              accessToken: "must-not-be-issued",
              tokenType: "Bearer" as const,
              expiresIn: 300,
              scope: "mcp",
            });
          },
        },
      });
      const response = await handler(
        new Request(`${issuer}/token`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            ...extraHeaders,
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code: "broker-code",
            client_id: "client",
            redirect_uri: "https://client.example/callback",
            resource,
            code_verifier: "v".repeat(64),
            ...extraForm,
          }),
        }),
      );

      expect(response.status).toBe(expectedStatus);
      expect(await response.json()).toMatchObject({
        error: "invalid_client",
        error_description: "Only unauthenticated public clients are supported",
      });
      expect(response.headers.get("www-authenticate")).toBe(expectedChallenge);
      expect(exchangeCalled).toBe(false);
    },
  );

  test("exposes constrained DCR only when configured and never returns client credentials", async () => {
    const disabled = createAuthorizationServerRouteHandler({ broker: brokerStub() });
    expect(
      await disabled(
        new Request(`${issuer}/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      ),
    ).toMatchObject({ status: 404 });

    const enabled = createAuthorizationServerRouteHandler({
      broker: brokerStub(),
      registration: registrationStub(),
      registrationRateLimitKey: () => "ip:192.0.2.1",
    });
    const response = await enabled(
      new Request(`${issuer}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          redirect_uris: ["https://client.example/callback"],
          grant_types: ["authorization_code"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      }),
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.client_id).toBe("registered-client");
    expect(body.client_secret).toBeUndefined();
    expect(body.registration_access_token).toBeUndefined();
  });

  test("rejects an oversized chunked DCR body before buffering the remaining stream", async () => {
    let pulls = 0;
    let canceled = false;
    let registered = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(9 * 1024));
        },
        cancel() {
          canceled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const handler = createAuthorizationServerRouteHandler({
      broker: brokerStub(),
      registration: {
        register: () => {
          registered = true;
          return registrationStub().register();
        },
      },
      registrationRateLimitKey: () => "ip:192.0.2.1",
    });

    const response = await handler(
      new Request(`${issuer}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: stream,
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_client_metadata" });
    expect(pulls).toBe(2);
    expect(canceled).toBe(true);
    expect(registered).toBe(false);
  });

  test("returns fail-closed OAuth errors without leaking internal exceptions", async () => {
    const handler = createAuthorizationServerRouteHandler({
      broker: {
        ...brokerStub(),
        beginAuthorization: () =>
          Promise.reject(new OAuthBrokerError("invalid_request", "invalid authorization request")),
      },
      registration: {
        register: () =>
          Promise.reject(new ConstrainedDcrError("too many registrations", "rate_limited", 429)),
      },
      registrationRateLimitKey: () => "ip:192.0.2.1",
    });

    const authorization = await handler(
      new Request(`${issuer}/authorize?client_id=bad&redirect_uri=https://attacker.example`),
    );
    expect(authorization.status).toBe(400);
    expect(await authorization.json()).toEqual({
      error: "invalid_request",
      error_description: "invalid authorization request",
    });

    const registration = await handler(
      new Request(`${issuer}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(registration.status).toBe(429);
    expect(await registration.json()).toEqual({
      error: "temporarily_unavailable",
      error_description: "too many registrations",
    });
    expect(registration.headers.get("retry-after")).toBe("60");
  });
});

function brokerStub() {
  return {
    authorizationServerMetadata: () => ({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    }),
    protectedResourceMetadata: () => ({
      resource,
      authorization_servers: [issuer],
      bearer_methods_supported: ["header"],
    }),
    jwks: () => ({
      keys: [{ kty: "RSA", kid: "active", alg: "RS256", use: "sig", n: "public", e: "AQAB" }],
    }),
    beginAuthorization: () =>
      Promise.resolve({
        authorizationUrl:
          "https://accounts.google.com/o/oauth2/v2/auth?state=broker-state&nonce=broker-nonce",
        client: {
          clientId: "client<unsafe>",
          clientName: "Client <unsafe>",
          clientUri: "https://client.example/about?x=1&y=2",
          redirectUris: ["https://client.example/callback?a=1&b=2"],
          scopes: ["mcp"],
        },
      }),
    completeGoogleAuthorization: () =>
      Promise.resolve({
        authorizationCode: "broker-code",
        redirectUrl: "https://client.example/callback?code=broker-code&state=opaque-client-state",
      }),
    denyGoogleAuthorization: () =>
      Promise.resolve({
        redirectUrl:
          "https://client.example/callback?error=access_denied&state=opaque-client-state",
      }),
    exchangeAuthorizationCode: () =>
      Promise.resolve({
        accessToken: "broker-access-token",
        tokenType: "Bearer" as const,
        expiresIn: 300,
        scope: "mcp",
      }),
  };
}

function registrationStub() {
  return {
    register: () =>
      Promise.resolve({
        client_id: "registered-client",
        client_id_issued_at: 1_800_000_000,
        redirect_uris: ["https://client.example/callback"],
        grant_types: ["authorization_code"] as ["authorization_code"],
        response_types: ["code"] as ["code"],
        token_endpoint_auth_method: "none" as const,
      }),
  };
}
