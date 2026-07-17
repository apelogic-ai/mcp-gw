import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

describe("DEV deploy wrapper", () => {
  test("provides AWS-profile-aware deploy and smoke entrypoints", async () => {
    await access("scripts/deploy-dev.sh", constants.X_OK);
    await access("scripts/dev-session.sh", constants.X_OK);
    await access("scripts/smoke-dev-remote.sh", constants.X_OK);

    const deploy = await readFile("scripts/deploy-dev.sh", "utf8");
    const session = await readFile("scripts/dev-session.sh", "utf8");
    const smoke = await readFile("scripts/smoke-dev-remote.sh", "utf8");
    const packageJson = await readFile("package.json", "utf8");

    expect(packageJson).toContain('"deploy:dev": "bash scripts/deploy-dev.sh"');
    expect(deploy).toContain('AWS_PROFILE="${AWS_PROFILE:-default}"');
    expect(deploy).toContain('AWS_REGION="${AWS_REGION:-us-east-1}"');
    expect(deploy).toContain(
      'aws --profile "$AWS_PROFILE" --region "$AWS_REGION" sts get-caller-identity',
    );
    expect(deploy).toContain("DEV_ENV_FILE");
    expect(deploy).toContain("terraform -chdir=");
    expect(deploy).toContain('git -C "$ROOT_DIR" archive');
    expect(deploy).toContain('aws --profile "$AWS_PROFILE" --region "$AWS_REGION" s3 cp');
    expect(deploy).toContain(
      'aws --profile "$AWS_PROFILE" --region "$AWS_REGION" ssm send-command',
    );
    expect(deploy).toContain('--parameters "file://$PARAMETERS_FILE"');
    expect(deploy).toContain(
      'aws --profile "$AWS_PROFILE" --region "$AWS_REGION" ssm wait command-executed',
    );
    expect(deploy).toContain("StandardOutputContent");
    expect(deploy).toContain('SCRIPT_S3_URI="s3://$ARTIFACT_BUCKET/scripts/$GIT_SHA.sh"');
    expect(deploy).toContain("bash /tmp/mcp-gateway-dev-deploy.sh");
    expect(deploy).toContain("aws ecr get-login-password");
    expect(deploy).toContain("docker login --username AWS --password-stdin");
    expect(deploy).toContain("AGENTGATEWAY_IMAGE");
    expect(deploy).toContain("ENABLE_GITHUB_MCP");
    expect(deploy).toContain("docker-compose.github-mcp.yaml");
    expect(deploy).toContain('name: github');
    expect(deploy).toContain("host: http://github-wrapper:8080/mcp");
    expect(deploy).not.toContain("GitHub MCP is deployed as a runtime-only DEV service");
    expect(deploy).not.toContain("host: http://db-mcp:8080/mcp");
    expect(deploy).toContain("handle /oauth/github/*");
    expect(deploy).toContain("reverse_proxy github-wrapper:8080");
    expect(session).toContain('AWS_PROFILE="${AWS_PROFILE:-default}"');
    expect(session).toContain('AWS_REGION="${AWS_REGION:-us-east-1}"');
    expect(session).toContain(
      'aws --profile "$AWS_PROFILE" --region "$AWS_REGION" ssm start-session --target',
    );
    expect(smoke).toContain("--tags smoke");
  });

  test("renders DEV gateway auth config and stages env without logging secrets", async () => {
    const playbook = await readFile("deploy/infra/ansible/deploy-compose.yml", "utf8");
    const gatewayTemplate = await readFile("deploy/infra/ansible/agentgateway-dev.yaml.j2", "utf8");
    const composeOverride = await readFile("deploy/compose/docker-compose.dev.yaml", "utf8");
    const deploy = await readFile("scripts/deploy-dev.sh", "utf8");

    expect(deploy).toContain("set +x");
    expect(deploy).toContain("deploy/compose/.env");
    expect(deploy).toContain('cat > "\\$APP_DIR.next/deploy/compose/.agentgateway-dev.yaml"');
    expect(playbook).toContain("dev_env_file");
    expect(playbook).toContain("git archive");
    expect(playbook).toContain("mcp-gateway.tar.gz");
    expect(playbook).toContain("no_log: true");
    expect(playbook).toContain("/var/log/mcp-gw");
    expect(playbook).toContain("agentgateway-dev.yaml.j2");
    expect(playbook).toContain("docker-compose.dev.yaml");
    expect(playbook).toContain("tags: [smoke]");
    expect(gatewayTemplate).toContain("mcpAuthentication:");
    expect(gatewayTemplate).toContain("hop1_issuers_json");
    expect(gatewayTemplate).toContain("providers:");
    expect(gatewayTemplate).toContain("discoverable:");
    expect(gatewayTemplate).toContain("issuer: {{ provider.issuer }}");
    expect(gatewayTemplate).toContain("url: {{ provider.jwksUrl }}");
    expect(gatewayTemplate).not.toContain("prefixMode: always");
    expect(gatewayTemplate).toContain("failureMode: failOpen");
    expect(gatewayTemplate).toContain("name: google");
    expect(gatewayTemplate).not.toContain("name: google-workspace");
    expect(gatewayTemplate).toContain("backendAuth:");
    expect(gatewayTemplate).toContain("passthrough: {}");
    expect(composeOverride).toContain(".agentgateway-dev.yaml");
  });
});
