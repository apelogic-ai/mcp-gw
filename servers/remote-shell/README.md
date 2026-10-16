# Remote shell MCP server

This opt-in first slice exposes one write-class tool, `remote_shell_run`, which runs one stateless
command through AWS Systems Manager Run Command. The agent names a configured role such as
`controller`; it never supplies an instance ID, address, SSM document, region, tag key, or cloud
credential.

The server accepts only verified Task tokens with a non-empty `runtime_uid` and the exact grant
`remote-shell / remote_shell_run / write`. `REMOTE_SHELL_BINDINGS_JSON` binds the verified HOP-1
`{issuer, subject}` and target role to an EC2 instance ID:

```json
[
  {
    "issuer": "https://identity.example.com",
    "subject": "principal-123",
    "targets": { "controller": "i-0123456789abcdef0" }
  }
]
```

Configure verified issuers with `HOP1_ISSUERS_JSON`. Optional settings are
`REMOTE_SHELL_RUN_TAG_KEY` (default `hypershell:run-id`), `REMOTE_SHELL_MAX_TIMEOUT_SECONDS`
(default 60), `REMOTE_SHELL_MAX_OUTPUT_BYTES` (default 24576), and `AWS_REGION`. Workload identity
supplies AWS credentials; never put them in bindings or tool arguments.

Before every command, the server uses its own credential to read the bound instance's EC2 tags and
requires the configured tag value to equal the verified `runtime_uid`. A missing or different tag,
or a lookup failure, is denied. Commands then use only `AWS-RunShellScript`, with argv/JSON rather
than a local shell. Results are bounded and credentials are redacted. Audit lines contain metadata
and a command digest, never the command, instance ID, output, bearer token, or AWS credentials.

## IAM backstops

Allow `ec2:DescribeTags`, the fixed SSM document, bound instances, and command-result reads. For a
per-run session tagged with `hypershell:run-id`, restrict `ssm:SendCommand` on each instance with:

```json
"Condition": {
  "StringEquals": {
    "aws:ResourceTag/hypershell:run-id": "${aws:PrincipalTag/hypershell:run-id}"
  }
}
```

Also deny `ec2:CreateTags` and `ec2:DeleteTags` for this key except to the trusted provisioner:

```json
"Condition": {
  "ForAnyValue:StringEquals": { "aws:TagKeys": ["hypershell:run-id"] },
  "ArnNotLike": { "aws:PrincipalArn": "arn:PARTITION:iam::ACCOUNT_ID:role/PROVISIONER_ROLE" }
}
```

Use the configured key consistently. Isolate the target network, minimize its instance role,
require metadata-service v2, and enforce lifecycle limits outside this server.

## Deferred

Interactive sessions, persistent state, platform-written bindings, template mode for persistent
hosts, server-side minting of per-run credentials, real-endpoint IAM tests, session-log links,
additional transports, chart wiring, and release/deploy work are outside this slice.
