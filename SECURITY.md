# Security policy

## Report privately

Report suspected vulnerabilities privately via [GitHub Private Vulnerability Reporting](https://github.com/ryan-winkler/meitheal/security/advisories/new) or email the maintainer at [hi@ryanw.eu](mailto:hi@ryanw.eu) with the subject **Meitheal security report**. Use a test installation and sample data.

Include the Meitheal version, install type, and steps to reproduce the problem. Explain which account or access level the steps need. Describe the data or action that the problem exposes.

Keep the report out of public issues and discussions. Remove access tokens, passwords, and household data. If you need to share sensitive evidence, ask the maintainer for a private transfer method.

## What to report

Report a problem that lets someone read or change data, act with more access than intended, or make the app unavailable. These boundaries matter in Meitheal.

- Pages and endpoints that expose household data or make changes must check the caller’s access.
- Forwarded identity must come from the trusted Home Assistant route.
- Tokens must grant access only to the operations allowed by their scope.
- Imports, task content, webhook destinations, and integration responses can contain untrusted input.
- Logs, backups, exports, and browser storage can contain household data. Report unintended access or disclosure.

Report what you observed and which version it affects. For a fault in a dependency, describe how the fault can be reached through Meitheal.

## After you report

The maintainer will acknowledge receipt of a private security report within 7 days (and always within 14 days), and may ask for a shorter reproduction or more version details. Coordinate disclosure by email so that users can update or take protective action.

Critical and high-severity vulnerabilities are prioritized for remediation within 60 days of confirmation. Fixed runtime vulnerabilities and CVE identifiers (when applicable) are documented in the GitHub Release notes, and security reporters are credited unless anonymity is requested.

## Supported versions

| Channel / Version | Support Status |
|---|---|
| `0.0.1` (`meitheal-hub` / Stable) | Supported — receives security fixes |
| `0.0.2-canary` (`meitheal-hub-canary` / `dev`) | Supported — active validation channel |
