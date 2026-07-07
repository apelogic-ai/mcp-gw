variable "aws_region" {
  description = "AWS region for DEV infrastructure."
  type        = string
  default     = "us-east-1"
}

variable "aws_cli_profile" {
  description = "AWS CLI profile name shown in helper output commands."
  type        = string
  default     = "default"
}

variable "dev_host_name" {
  description = "Name tag for the AWS DEV Docker Compose host."
  type        = string
  default     = "mcp-gateway-dev"
}

variable "vpc_id" {
  description = "VPC ID containing the DEV host. When null, the default VPC is used."
  type        = string
  default     = null
}

variable "subnet_id" {
  description = "Subnet ID for the DEV host. When null, the first subnet in the selected VPC is used."
  type        = string
  default     = null
}

variable "allowed_ingress_cidrs" {
  description = "CIDR blocks allowed to reach break-glass SSH and the temporary direct gateway port."
  type        = list(string)
}

variable "public_web_ingress_cidrs" {
  description = "CIDR blocks allowed to reach public HTTP/HTTPS for TLS, MCP, and OAuth callbacks."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "dev_ssh_public_key" {
  description = "Break-glass public SSH key allowed to access the DEV host as ubuntu."
  type        = string
  default     = null
}

variable "enable_break_glass_ssh" {
  description = "Allow SSH from allowed_ingress_cidrs for break-glass access. SSM is the canonical operator access path."
  type        = bool
  default     = false
}

variable "dev_host_key_name" {
  description = "AWS EC2 key pair name for the DEV host."
  type        = string
  default     = "mcp-gateway-dev"
}

variable "dev_instance_type" {
  description = "EC2 instance type for the DEV Docker Compose host."
  type        = string
  default     = "t3.medium"
}

variable "dev_root_volume_size_gb" {
  description = "Root EBS volume size for the DEV host."
  type        = number
  default     = 40
}

variable "dev_gateway_port" {
  description = "Temporary DEV public gateway port until TLS/ingress is added."
  type        = number
  default     = 8080
}

variable "dev_artifact_bucket_name" {
  description = "Optional S3 bucket name for SSM-based DEV deployment artifacts. When null, a deterministic account/region-scoped name is used."
  type        = string
  default     = null
}
