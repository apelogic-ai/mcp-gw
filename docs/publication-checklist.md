# Publication Checklist

Use this checklist before making the repository public or accepting outside contributions.

## Required

- Confirm the MIT license and copyright holder are correct for the publishing organization.
- Run a full git-history secret scan with a tool such as `gitleaks` or `trufflehog`.
- Confirm no live environment URLs, account IDs, OAuth client IDs, SSO profile names, email
  addresses, private hostnames, or private repo paths remain in tracked files.
- Confirm `.env`, Terraform state, key files, and cloud credentials are ignored and not present in
  git history.
- Review `NOTICE.md` for third-party attribution requirements.
- Review Google OAuth scopes and consent-screen verification requirements for the intended audience.
- Decide whether public issues and pull requests are accepted; if yes, add contribution guidance.

## Recommended

- Publish public examples using placeholder domains such as `https://mcp.example.com`.
- Keep deployment-specific runbooks in a private operations repository.
- Use environment-specific OAuth clients instead of reusing a DEV client for public docs.
- Verify the public README describes current tool filtering and connector limits.
