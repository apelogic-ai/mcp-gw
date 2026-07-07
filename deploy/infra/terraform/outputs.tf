output "mcp_gateway_dev_security_group_id" {
  description = "Security group ID for the DEV Docker Compose host."
  value       = aws_security_group.mcp_gateway_dev.id
}

output "mcp_gateway_dev_artifact_bucket" {
  description = "Private S3 bucket used for SSM-based DEV deployment artifacts."
  value       = aws_s3_bucket.mcp_gateway_dev_artifacts.id
}

output "mcp_gateway_dev_agentgateway_ecr_repository_url" {
  description = "Private ECR repository URL for DEV agentgateway images."
  value       = aws_ecr_repository.agentgateway_dev.repository_url
}

output "mcp_gateway_dev_agentgateway_codebuild_project_name" {
  description = "CodeBuild project that builds DEV agentgateway images for ECR."
  value       = aws_codebuild_project.agentgateway_dev_image.name
}

output "mcp_gateway_dev_instance_id" {
  description = "Canonical SSM target ID for the DEV Docker Compose host."
  value       = aws_instance.mcp_gateway_dev.id
}

output "mcp_gateway_dev_ssm_start_session_command" {
  description = "Command for opening an SSM shell session to the DEV host."
  value       = "aws --profile ${var.aws_cli_profile} --region ${var.aws_region} ssm start-session --target ${aws_instance.mcp_gateway_dev.id}"
}

output "mcp_gateway_dev_public_ip" {
  description = "Stable Elastic IP for the DEV Docker Compose host."
  value       = aws_eip.mcp_gateway_dev.public_ip
}

output "mcp_gateway_dev_public_origin" {
  description = "Temporary HTTPS origin for DEV using nip.io."
  value       = "https://${aws_eip.mcp_gateway_dev.public_ip}.nip.io"
}

output "mcp_gateway_dev_google_oauth_redirect_uri" {
  description = "Google OAuth redirect URI for the temporary DEV nip.io origin."
  value       = "https://${aws_eip.mcp_gateway_dev.public_ip}.nip.io/oauth/google/callback"
}

output "mcp_gateway_dev_public_dns" {
  description = "Public DNS name for the DEV Docker Compose host Elastic IP."
  value       = aws_eip.mcp_gateway_dev.public_dns
}

output "mcp_gateway_dev_ssh_user" {
  description = "SSH user for the Ubuntu DEV host."
  value       = "ubuntu"
}
