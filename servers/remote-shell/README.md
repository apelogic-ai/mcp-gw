# Remote shell HTTP server

This opt-in server runs one stateless command through AWS Systems Manager Run Command. It is a
governed HTTP endpoint, not an MCP backend. The agent names a configured role such as `controller`;
it never supplies an instance ID, address, SSM document, region, tag key, or cloud credential.

- `POST /shell/run` accepts `{target, command, timeout_seconds}` and returns buffered NDJSON after
  the command finishes. Add `?wait=full` for one `{exit_code, stdout, stderr}` JSON response.
- `POST /shell/jobs` starts an asynchronous command and returns the SSM command ID as `job_id`.
  `GET /shell/jobs/{job_id}` reads its status, and `POST /shell/jobs/{job_id}/cancel` cancels it.
- Jobs are visible only when the server itself recorded the same verified issuer, subject, and
  `runtime_uid`. A valid SSM command ID from another run or another caller returns 404.

Systems Manager does not expose incremental command output unless output is sent elsewhere, such
as CloudWatch Logs. This slice therefore has no live stream endpoint; its NDJSON is emitted only
after the command finishes.

The server accepts only verified Task tokens with a non-empty `runtime_uid`, the exact grant
`remote-shell / remote_shell_run / write`, and a signed `steward.remote_shell_targets` object. The
claim maps each platform role to its SSM instance ID:

```json
{
  "steward": {
    "version": 3,
    "acting_as": "user",
    "runtime_uid": "runtime-123",
    "remote_shell_targets": {
      "controller": "i-0123456789abcdef0"
    },
    "tools": [{ "provider": "remote-shell", "resource": "remote_shell_run", "action": "write" }]
  }
}
```

The token issuer must derive this object from its trusted run-to-resource record and sign it with
the same key that signs the rest of the run token. Role names must match
`^[a-z][a-z0-9-]{0,62}$`; values must be EC2 instance IDs. A missing, empty, malformed, or
non-matching target claim is denied before any AWS command runs.

Configure verified issuers with `HOP1_ISSUERS_JSON`. Optional settings are
`REMOTE_SHELL_MAX_TIMEOUT_SECONDS` (default 60), `REMOTE_SHELL_MAX_OUTPUT_BYTES` (default 24576),
`REMOTE_SHELL_MAX_COMMAND_BYTES` (default 16384), `REMOTE_SHELL_MAX_BODY_BYTES` (default 17408),
`REMOTE_SHELL_MAX_JOBS` (default 64), `REMOTE_SHELL_MAX_RUNNING_JOBS_PER_OWNER` (default 4),
`REMOTE_SHELL_JOB_RETENTION_SECONDS` (default 1800), and `AWS_REGION`. Workload identity supplies AWS
credentials; never put them in token claims or tool arguments.

Before every command, the server resolves the requested role only from the already verified signed
claim. EC2 instance tags are not read and cannot authorize a target. Commands use only
`AWS-RunShellScript`, with argv/JSON rather than a local shell. Results are bounded and credentials
are redacted. Audit lines contain metadata and a command digest, never the command, instance ID,
output, bearer token, or AWS credentials.

## IAM backstops

Allow `ssm:GetCommandInvocation`, the fixed SSM document, and only provisioner-managed target
instances for `ssm:SendCommand`. The service no longer needs `ec2:DescribeTags`.

Cancellation also requires `ssm:CancelCommand`. AWS does not support resource-level ARNs or
service-specific condition keys for that action, so its IAM statement must use `Resource: "*"`.
The server narrows every cancellation request to the instance ID in its own authorized job record;
it never accepts an instance ID from the HTTP request. Keep this permission on the remote-shell
workload role only, and use organization guardrails where broader control is required.

Isolate the target network, minimize its instance role, require metadata-service v2, and enforce
lifecycle limits outside this server.

## Deferred

Interactive sessions, persistent state, template mode for persistent hosts, server-side minting of
per-run credentials, real-endpoint IAM tests, session-log links, additional transports, and
release/deploy work are outside this slice.
