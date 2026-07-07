data "aws_vpc" "default" {
  count   = var.vpc_id == null ? 1 : 0
  default = true
}

data "aws_subnets" "selected" {
  filter {
    name   = "vpc-id"
    values = [local.vpc_id]
  }
}

data "aws_caller_identity" "current" {}

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"]

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }

  filter {
    name   = "root-device-type"
    values = ["ebs"]
  }
}

data "aws_iam_policy_document" "ec2_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "codebuild_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["codebuild.amazonaws.com"]
    }
  }
}

locals {
  vpc_id                = var.vpc_id != null ? var.vpc_id : data.aws_vpc.default[0].id
  subnet_id             = var.subnet_id != null ? var.subnet_id : sort(data.aws_subnets.selected.ids)[0]
  artifact_bucket_name  = var.dev_artifact_bucket_name != null ? var.dev_artifact_bucket_name : "${var.dev_host_name}-${data.aws_caller_identity.current.account_id}-${var.aws_region}-artifacts"
  agentgateway_ecr_name = "${var.dev_host_name}/agentgateway"
}

resource "aws_ecr_repository" "agentgateway_dev" {
  name                 = local.agentgateway_ecr_name
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = {
    Name      = local.agentgateway_ecr_name
    Component = "mcp-gateway-dev"
  }
}

resource "aws_ecr_lifecycle_policy" "agentgateway_dev" {
  repository = aws_ecr_repository.agentgateway_dev.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep the last 20 DEV agentgateway images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 20
        }
        action = {
          type = "expire"
        }
      },
    ]
  })
}

resource "aws_cloudwatch_log_group" "agentgateway_dev_image_build" {
  name              = "/aws/codebuild/${var.dev_host_name}-agentgateway-image"
  retention_in_days = 14

  tags = {
    Name      = "${var.dev_host_name}-agentgateway-image"
    Component = "mcp-gateway-dev"
  }
}

resource "aws_iam_role" "agentgateway_dev_image_build" {
  name               = "${var.dev_host_name}-agentgateway-image-build"
  assume_role_policy = data.aws_iam_policy_document.codebuild_assume_role.json

  tags = {
    Name      = "${var.dev_host_name}-agentgateway-image-build"
    Component = "mcp-gateway-dev"
  }
}

resource "aws_iam_role_policy" "agentgateway_dev_image_build" {
  name = "${var.dev_host_name}-agentgateway-image-build"
  role = aws_iam_role.agentgateway_dev_image_build.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ]
        Resource = "${aws_cloudwatch_log_group.agentgateway_dev_image_build.arn}:*"
      },
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
        ]
        Resource = "${aws_s3_bucket.mcp_gateway_dev_artifacts.arn}/*"
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:GetAuthorizationToken",
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:CompleteLayerUpload",
          "ecr:InitiateLayerUpload",
          "ecr:PutImage",
          "ecr:UploadLayerPart",
        ]
        Resource = aws_ecr_repository.agentgateway_dev.arn
      },
    ]
  })
}

resource "aws_codebuild_project" "agentgateway_dev_image" {
  name         = "${var.dev_host_name}-agentgateway-image"
  description  = "Builds DEV agentgateway fork images from S3 source archives."
  service_role = aws_iam_role.agentgateway_dev_image_build.arn

  artifacts {
    type = "NO_ARTIFACTS"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_LARGE"
    image                       = "aws/codebuild/standard:7.0"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"
    privileged_mode             = true
  }

  logs_config {
    cloudwatch_logs {
      group_name  = aws_cloudwatch_log_group.agentgateway_dev_image_build.name
      stream_name = "build"
    }
  }

  source {
    type      = "NO_SOURCE"
    buildspec = <<-BUILDSPEC
      version: 0.2
      phases:
        pre_build:
          commands:
            - test -n "$SOURCE_S3_URI"
            - test -n "$IMAGE_REPO"
            - test -n "$IMAGE_TAG"
            - test -n "$IMAGE_VERSION"
            - aws s3 cp "$SOURCE_S3_URI" /tmp/agentgateway.tar.gz
            - mkdir -p /tmp/agentgateway-src
            - tar -xzf /tmp/agentgateway.tar.gz -C /tmp/agentgateway-src
            - ECR_REGISTRY="$${IMAGE_REPO%%/*}"
            - aws ecr get-login-password --region "$AWS_DEFAULT_REGION" | docker login --username AWS --password-stdin "$ECR_REGISTRY"
        build:
          commands:
            - cd /tmp/agentgateway-src
            - docker build --build-arg VERSION="$IMAGE_VERSION" --build-arg GIT_REVISION="$IMAGE_TAG" -t "$IMAGE_REPO:$IMAGE_TAG" -t "$IMAGE_REPO:mcp-auth-multi-provider" .
        post_build:
          commands:
            - docker push "$IMAGE_REPO:$IMAGE_TAG"
            - docker push "$IMAGE_REPO:mcp-auth-multi-provider"
      BUILDSPEC
  }

  tags = {
    Name      = "${var.dev_host_name}-agentgateway-image"
    Component = "mcp-gateway-dev"
  }
}

resource "aws_s3_bucket" "mcp_gateway_dev_artifacts" {
  bucket = local.artifact_bucket_name

  tags = {
    Name      = local.artifact_bucket_name
    Component = "mcp-gateway-dev"
  }
}

resource "aws_s3_bucket_public_access_block" "mcp_gateway_dev_artifacts" {
  bucket = aws_s3_bucket.mcp_gateway_dev_artifacts.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "mcp_gateway_dev_artifacts" {
  bucket = aws_s3_bucket.mcp_gateway_dev_artifacts.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "mcp_gateway_dev_artifacts" {
  bucket = aws_s3_bucket.mcp_gateway_dev_artifacts.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_security_group" "mcp_gateway_dev" {
  name        = var.dev_host_name
  description = "Ingress for MCP gateway DEV Docker Compose host"
  vpc_id      = local.vpc_id

  dynamic "ingress" {
    for_each = var.enable_break_glass_ssh ? [1] : []

    content {
      description = "Break-glass SSH for emergency access"
      from_port   = 22
      to_port     = 22
      protocol    = "tcp"
      cidr_blocks = var.allowed_ingress_cidrs
    }
  }

  ingress {
    description = "HTTP for gateway/OAuth callback during DEV"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = var.public_web_ingress_cidrs
  }

  ingress {
    description = "Temporary DEV MCP gateway port"
    from_port   = var.dev_gateway_port
    to_port     = var.dev_gateway_port
    protocol    = "tcp"
    cidr_blocks = var.allowed_ingress_cidrs
  }

  ingress {
    description = "HTTPS for gateway/OAuth callback during DEV"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = var.public_web_ingress_cidrs
  }

  egress {
    description = "Outbound internet for SSM, Google APIs, and image pulls"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name      = var.dev_host_name
    Component = "mcp-gateway-dev"
  }
}

resource "aws_iam_role" "mcp_gateway_dev" {
  name               = var.dev_host_name
  assume_role_policy = data.aws_iam_policy_document.ec2_assume_role.json

  tags = {
    Name      = var.dev_host_name
    Component = "mcp-gateway-dev"
  }
}

resource "aws_iam_role_policy_attachment" "mcp_gateway_dev_ssm" {
  role       = aws_iam_role.mcp_gateway_dev.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "mcp_gateway_dev_artifacts" {
  name = "${var.dev_host_name}-artifacts"
  role = aws_iam_role.mcp_gateway_dev.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
        ]
        Resource = "${aws_s3_bucket.mcp_gateway_dev_artifacts.arn}/*"
      },
      {
        Effect = "Allow"
        Action = [
          "s3:ListBucket",
        ]
        Resource = aws_s3_bucket.mcp_gateway_dev_artifacts.arn
      },
    ]
  })
}

resource "aws_iam_role_policy" "mcp_gateway_dev_ecr_pull" {
  name = "${var.dev_host_name}-ecr-pull"
  role = aws_iam_role.mcp_gateway_dev.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ecr:GetAuthorizationToken",
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer",
        ]
        Resource = aws_ecr_repository.agentgateway_dev.arn
      },
    ]
  })
}

resource "aws_iam_instance_profile" "mcp_gateway_dev" {
  name = var.dev_host_name
  role = aws_iam_role.mcp_gateway_dev.name

  tags = {
    Name      = var.dev_host_name
    Component = "mcp-gateway-dev"
  }
}

resource "aws_key_pair" "mcp_gateway_dev" {
  count = var.enable_break_glass_ssh ? 1 : 0

  key_name   = var.dev_host_key_name
  public_key = var.dev_ssh_public_key

  tags = {
    Name      = var.dev_host_key_name
    Component = "mcp-gateway-dev"
  }
}

resource "aws_instance" "mcp_gateway_dev" {
  ami                         = data.aws_ami.ubuntu.id
  instance_type               = var.dev_instance_type
  subnet_id                   = local.subnet_id
  vpc_security_group_ids      = [aws_security_group.mcp_gateway_dev.id]
  key_name                    = var.enable_break_glass_ssh ? aws_key_pair.mcp_gateway_dev[0].key_name : null
  iam_instance_profile        = aws_iam_instance_profile.mcp_gateway_dev.name
  associate_public_ip_address = true
  user_data_replace_on_change = false

  lifecycle {
    prevent_destroy = true
  }

  root_block_device {
    volume_size = var.dev_root_volume_size_gb
    volume_type = "gp3"
    encrypted   = true
  }

  user_data = <<-USERDATA
    #!/usr/bin/env bash
    set -euo pipefail
    apt-get update
    apt-get install -y awscli ca-certificates curl gnupg python3 snapd
    systemctl enable --now snapd.socket
    snap list amazon-ssm-agent >/dev/null 2>&1 || snap install amazon-ssm-agent --classic
    systemctl enable --now snap.amazon-ssm-agent.amazon-ssm-agent.service
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    . /etc/os-release
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" > /etc/apt/sources.list.d/docker.list
    apt-get update
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    usermod -aG docker ubuntu
    systemctl enable --now docker
  USERDATA

  tags = {
    Name      = var.dev_host_name
    Component = "mcp-gateway-dev"
  }
}

resource "aws_eip" "mcp_gateway_dev" {
  domain = "vpc"

  tags = {
    Name      = var.dev_host_name
    Component = "mcp-gateway-dev"
  }
}

resource "aws_eip_association" "mcp_gateway_dev" {
  allocation_id = aws_eip.mcp_gateway_dev.id
  instance_id   = aws_instance.mcp_gateway_dev.id
}
