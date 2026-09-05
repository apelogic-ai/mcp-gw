import { randomUUID } from "node:crypto";

import { Pool } from "pg";

import { createPostgresQueryClient } from "../../shared/oauth/postgres-client";
import { SqlAuthorizationBrokerStore } from "../../shared/oauth/sql-authorization-store";

const connectionString = process.env.TOKEN_STORE_DSN;
if (!connectionString) {
  throw new Error("TOKEN_STORE_DSN is required");
}

const trials = 25;
const pool = new Pool({ connectionString });
const first = new SqlAuthorizationBrokerStore(createPostgresQueryClient(pool));
const second = new SqlAuthorizationBrokerStore(createPostgresQueryClient(pool));

try {
  for (let index = 0; index < trials; index += 1) {
    const unique = randomUUID();
    const familyId = `integration-family-${unique}`;
    const tokenHash = `integration-parent-${unique}`;
    const replacements = [
      `integration-child-a-${unique}`,
      `integration-child-b-${unique}`,
    ] as const;
    const now = Date.now();

    try {
      await first.saveRefreshToken({
        tokenHash,
        familyId,
        clientId: "integration-client",
        resource: "https://mcp.example.com/mcp",
        scopes: ["mcp"],
        identity: {
          issuer: "https://accounts.google.com",
          subject: "integration-subject",
          email: "integration@example.com",
          emailVerified: true,
        },
        expiresAt: now + 60_000,
      });

      const attempts = await Promise.all([
        first.rotateRefreshToken({
          tokenHash,
          replacementTokenHash: replacements[0],
          clientId: "integration-client",
          resource: "https://mcp.example.com/mcp",
          now,
        }),
        second.rotateRefreshToken({
          tokenHash,
          replacementTokenHash: replacements[1],
          clientId: "integration-client",
          resource: "https://mcp.example.com/mcp",
          now,
        }),
      ]);
      const statuses = attempts.map(({ status }) => status).sort();
      if (JSON.stringify(statuses) !== JSON.stringify(["replayed", "rotated"])) {
        throw new Error(`Unexpected concurrent rotation results: ${statuses.join(",")}`);
      }

      const winner = attempts.findIndex(({ status }) => status === "rotated");
      const winnerHash = replacements[winner];
      const descendant = await pool.query(
        "SELECT revoked_at FROM oauth_broker_refresh_tokens WHERE token_hash = $1",
        [winnerHash],
      );
      if (!(descendant.rows[0]?.revoked_at instanceof Date)) {
        throw new Error("Replay did not revoke the concurrently inserted descendant");
      }

      const descendantAttempt = await first.rotateRefreshToken({
        tokenHash: winnerHash,
        replacementTokenHash: `integration-grandchild-${unique}`,
        clientId: "integration-client",
        resource: "https://mcp.example.com/mcp",
        now: now + 1,
      });
      if (descendantAttempt.status !== "invalid") {
        throw new Error("A descendant remained usable after refresh-family replay");
      }
    } finally {
      await pool.query("DELETE FROM oauth_broker_refresh_tokens WHERE family_id = $1", [familyId]);
    }
  }

  console.log(`PostgreSQL refresh-family replay smoke passed: ${String(trials)} trials.`);
} finally {
  await pool.end();
}
