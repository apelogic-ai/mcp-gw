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
and `REMOTE_SHELL_MAX_OUTPUT_BYTES` (default 24576). `REMOTE_SHELL_RUN_TAG_KEY` selects the
operator-controlled EC2 tag key (default `hypershell:run-id`); the tool request cannot override it.
`AWS_REGION` selects the Systems Manager region. Workload identity supplies AWS credentials; never
put credentials in the binding or tool arguments.

Immediately before every command, the server reads the bound instance's EC2 tags with its own AWS
credential and requires the configured tag value to equal the verified Task `runtime_uid`. A
missing or different tag, or a lookup failure, is denied. The server then always uses
`AWS-RunShellScript`, invokes the AWS CLI without a local shell, bounds local AWS responses, and
truncates returned stdout and stderr independently. Audit lines record the runtime UID, target role,
command digest, exit code, duration, output sizes, and truncation flags; they do not contain the
command, instance ID, output, bearer token, or AWS credentials.

## IAM example

The server needs `ec2:DescribeTags` for the run-binding check. As a defense in depth, give each
per-run deployment session credentials carrying the run ID as the `hypershell:run-id` session tag,
then allow `ssm:SendCommand` on an instance only when its resource tag matches that principal tag.
Replace the placeholders and use the configured tag key consistently:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "ec2:DescribeTags",
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": "ssm:SendCommand",
      "Resource": "arn:PARTITION:ssm:REGION::document/AWS-RunShellScript"
    },
    {
      "Effect": "Allow",
      "Action": "ssm:SendCommand",
      "Resource": "arn:PARTITION:ec2:REGION:ACCOUNT_ID:instance/INSTANCE_ID",
      "Condition": {
        "StringEquals": {
          "aws:ResourceTag/hypershell:run-id": "${aws:PrincipalTag/hypershell:run-id}"
        }
      }
    },
    {
      "Effect": "Allow",
      "Action": "ssm:GetCommandInvocation",
      "Resource": "*"
    }
  ]
}
```

Lock down the authorization tag itself. An IAM boundary or organization SCP should deny changing
that key to every principal except the trusted provisioner; otherwise a tag writer could make any
machine appear run-bound. For example:

```json
{
  "Effect": "Deny",
  "Action": ["ec2:CreateTags", "ec2:DeleteTags"],
  "Resource": "arn:PARTITION:ec2:REGION:ACCOUNT_ID:instance/*",
  "Condition": {
    "ForAnyValue:StringEquals": {
      "aws:TagKeys": ["hypershell:run-id"]
    },
    "ArnNotLike": {
      "aws:PrincipalArn": "arn:PARTITION:iam::ACCOUNT_ID:role/PROVISIONER_ROLE"
    }
  }
}
```

The target machine remains the security boundary: isolate its network, minimize its instance role,
require metadata-service v2, and enforce lifecycle limits outside this server.

## Deferred

Interactive sessions (`open`, `read`, and `close`), persistent working state, per-run platform-written
bindings, template mode for persistent hosts, minting per-run session credentials in the server,
multiple transports, cloud session-log links, and the shared governed CLI runner core are outside
this slice. Deployment/chart wiring is also separate.
