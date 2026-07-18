import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("DEV infrastructure skeleton", () => {
  test("defines Terraform inputs for AWS DEV compose host", async () => {
    const variables = await readFile("deploy/infra/terraform/variables.tf", "utf8");
    const main = await readFile("deploy/infra/terraform/main.tf", "utf8");

    expect(variables).toContain('variable "dev_host_name"');
    expect(variables).toContain('variable "allowed_ingress_cidrs"');
    expect(variables).toContain('variable "dev_ssh_public_key"');
    expect(variables).toContain('variable "dev_instance_type"');
    expect(variables).toContain('variable "enable_break_glass_ssh"');
    expect(variables).toContain('variable "public_web_ingress_cidrs"');
    expect(main).toContain("aws_security_group");
    expect(main).toContain("public_web_ingress_cidrs");
    expect(main).toContain("aws_key_pair");
    expect(main).toContain("aws_instance");
    expect(main).toContain("aws_iam_instance_profile");
    expect(main).toContain("AmazonSSMManagedInstanceCore");
    expect(main).toContain("aws_s3_bucket");
    expect(main).toContain("s3:GetObject");
    expect(main).toContain("aws_ecr_repository");
    expect(main).toContain("encryption_configuration");
    expect(main).toContain('encryption_type = "AES256"');
    expect(main).toContain("ecr:GetAuthorizationToken");
    expect(main).toContain("ecr:BatchGetImage");
    expect(main).toContain("ecr:GetDownloadUrlForLayer");
    expect(main).toContain("aws_codebuild_project");
    expect(main).toContain("codebuild.amazonaws.com");
    expect(main).toContain("privileged_mode             = true");
    expect(main).toContain('type      = "NO_SOURCE"');
    expect(main).toContain("ecr:PutImage");
    expect(main).toContain("s3:GetObject");
    expect(main).toContain('ECR_REGISTRY="$${IMAGE_REPO%%/*}"');
    expect(main).toContain("aws_eip");
    expect(main).toContain("metadata_options");
    expect(main).toContain('http_tokens                 = "required"');
    expect(main).toContain("http_put_response_hop_limit = 1");
    expect(main).toContain("prevent_destroy = true");
    expect(main).toContain("user_data_replace_on_change = false");
    expect(main).toContain("snap.amazon-ssm-agent.amazon-ssm-agent.service");
    expect(main).toContain("enable_break_glass_ssh");
    expect(main).toContain('data "aws_ami" "ubuntu"');
    expect(main).toContain("mcp_gateway_dev");
  });

  test("does not allow public SSH ingress or IMDSv1 on DEV EC2", async () => {
    const variables = await readFile("deploy/infra/terraform/variables.tf", "utf8");
    const main = await readFile("deploy/infra/terraform/main.tf", "utf8");

    expect(variables).toContain("validation {");
    expect(variables).toContain('cidr != "0.0.0.0/0"');
    expect(variables).toContain('cidr != "::/0"');
    expect(main).toContain('description = "Break-glass SSH for emergency access"');
    expect(main).toContain("cidr_blocks = var.allowed_ingress_cidrs");
    expect(main).toContain("metadata_options");
    expect(main).toContain('http_endpoint               = "enabled"');
    expect(main).toContain('http_tokens                 = "required"');
  });

  test("outputs DEV host connection details with SSM as canonical access", async () => {
    const outputs = await readFile("deploy/infra/terraform/outputs.tf", "utf8");
    const example = await readFile("deploy/infra/terraform/terraform.tfvars.example", "utf8");

    expect(outputs).toContain("mcp_gateway_dev_ssm_start_session_command");
    expect(outputs).toContain("mcp_gateway_dev_public_origin");
    expect(outputs).toContain("mcp_gateway_dev_google_oauth_redirect_uri");
    expect(outputs).toContain("https://${aws_eip.mcp_gateway_dev.public_ip}.nip.io");
    expect(outputs).toContain(
      "aws --profile ${var.aws_cli_profile} --region ${var.aws_region} ssm start-session --target",
    );
    expect(outputs).toContain("mcp_gateway_dev_instance_id");
    expect(outputs).toContain("mcp_gateway_dev_public_ip");
    expect(outputs).toContain("mcp_gateway_dev_public_dns");
    expect(outputs).toContain("aws_eip.mcp_gateway_dev.public_dns");
    expect(outputs).toContain("mcp_gateway_dev_ssh_user");
    expect(outputs).toContain("mcp_gateway_dev_artifact_bucket");
    expect(outputs).toContain("mcp_gateway_dev_agentgateway_ecr_repository_url");
    expect(outputs).toContain("mcp_gateway_dev_agentgateway_codebuild_project_name");
    expect(example).toContain("dev_ssh_public_key");
    expect(example).toContain("enable_break_glass_ssh");
    expect(example).toContain('aws_region            = "us-east-1"');
  });

  test("defines Ansible inventory and compose deployment playbook", async () => {
    const inventory = await readFile("deploy/infra/ansible/inventory.example.ini", "utf8");
    const playbook = await readFile("deploy/infra/ansible/deploy-compose.yml", "utf8");
    const envTemplate = await readFile("deploy/infra/ansible/env.j2", "utf8");

    expect(inventory).toContain("[mcp_gateway_dev]");
    expect(playbook).toContain("Install Docker");
    expect(playbook).toContain("git archive");
    expect(playbook).toContain("docker compose");
    expect(playbook).toContain("docker-compose.dev.yaml");
    expect(playbook).toContain("scripts/smoke-compose.sh");
    expect(envTemplate).toContain("HOP1_OAUTH_SCOPES={{ hop1_oauth_scopes");
    expect(envTemplate).toContain("GOOGLE_OAUTH_SCOPES={{ google_oauth_scopes");
  });
});
