# Remote shell MCP server

This first slice exposes one write-class MCP tool, `remote_shell_run`. It runs one stateless command
through AWS Systems Manager Run Command. The agent names a configured role such as `controller`; it
never supplies an instance ID, address, SSM document, region, or cloud credential.

The server accepts only verified Task tokens with the exact grant
`remote-shell / remote_shell_run / write` and a non-empty Task `runtime_uid`. Static configuration
binds the verified HOP-1 `{issuer, subject}` principal and target role to an EC2 instance ID:

```json
[
  {
    "issuer": "https://identity.example.com",
    "subject": "principal-123",
    "targets": { "controller": "i-0123456789abcdef0" }
  }
]
```

Set that JSON as `REMOTE_SHELL_BINDINGS_JSON`. Configure verified issuers with the existing
`HOP1_ISSUERS_JSON` contract. Optional limits are `REMOTE_SHELL_MAX_TIMEOUT_SECONDS` (default 60)
and `REMOTE_SHELL_MAX_OUTPUT_BYTES` (default 24576). `AWS_REGION` selects the Systems Manager
region. Workload identity supplies AWS credentials; never put credentials in the binding or tool
arguments.

The server always uses `AWS-RunShellScript`, invokes the AWS CLI without a local shell, bounds local
AWS responses, and truncates returned stdout and stderr independently. Audit lines record the
runtime UID, target role, command digest, exit code, duration, output sizes, and truncation flags;
they do not contain the command, instance ID, output, bearer token, or AWS credentials.

## IAM example

Restrict `ssm:SendCommand` to the configured instances and the one pinned document. Replace the
placeholders, and keep the workload role scoped to only the instances present in the binding:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "ssm:SendCommand",
      "Resource": [
        "arn:PARTITION:ssm:REGION::document/AWS-RunShellScript",
        "arn:PARTITION:ec2:REGION:ACCOUNT_ID:instance/INSTANCE_ID"
      ]
    },
    {
      "Effect": "Allow",
      "Action": "ssm:GetCommandInvocation",
      "Resource": "*"
    }
  ]
}
```

The target machine remains the security boundary: isolate its network, minimize its instance role,
require metadata-service v2, and enforce lifecycle limits outside this server.

## Deferred

Interactive sessions (`open`, `read`, and `close`), persistent working state, per-run platform-written
bindings, tag discovery, multiple transports, cloud session-log links, and the shared governed CLI
runner core are outside this slice. Deployment/chart wiring is also separate.
