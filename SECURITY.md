# Security Policy

## Reporting Vulnerabilities

Do not open a public issue for vulnerabilities or leaked credentials.

Use [GitHub private vulnerability reporting](https://github.com/apelogic-ai/mcp-gw/security/advisories/new)
whenever possible. It creates a private advisory visible only to the reporter and repository
security maintainers. If GitHub private reporting is unavailable, email `lbeliaev@gmail.com` with
the subject `mcp-gw security report`.

Include:

- affected component and version or commit;
- reproduction steps;
- expected impact;
- any relevant logs with tokens, secrets, and personal data redacted.

You should receive an acknowledgement within five business days. Please allow the maintainers time
to investigate and coordinate a fix before publishing details.

## Supported Versions

Security fixes are applied to the latest released version. Older versions may require upgrading to
receive a fix. Release and upgrade notes identify any migration, credential-rotation, or
reauthorization action required by a security update.

## Secret Handling

Never commit:

- OAuth client secrets;
- Google refresh tokens or access tokens;
- `GOOGLE_TOKEN_ENCRYPTION_KEY`;
- `.env` files with real values;
- infrastructure state or variable files containing secrets;
- cloud credentials, SSH keys, or service account keys.

Run a history secret scan before making any fork or mirror public.

## Deployment Defaults

Local Compose files are development templates. Production deployments should use the released Helm
chart with private values and review network ingress, database credentials, token encryption, audit
retention, OAuth scopes, and policy defaults before use.
