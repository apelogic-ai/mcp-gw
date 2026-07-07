# Security Policy

## Reporting Vulnerabilities

Do not open public issues for vulnerabilities or leaked credentials.

Send security reports to the repository owners through the private channel configured for your
deployment. Include:

- affected component and version or commit;
- reproduction steps;
- expected impact;
- any relevant logs with tokens, secrets, and personal data redacted.

## Secret Handling

Never commit:

- OAuth client secrets;
- Google refresh tokens or access tokens;
- `GOOGLE_TOKEN_ENCRYPTION_KEY`;
- `.env` files with real values;
- Terraform state or variable files containing secrets;
- AWS credentials, SSH keys, or service account keys.

Run a history secret scan before making any fork or mirror public.

## Deployment Defaults

Example compose and Terraform files are development templates. Production deployments should review
network ingress, database credentials, token encryption, audit retention, OAuth scopes, and policy
defaults before use.
