# Security policy

## Report privately

Email [the maintainer](mailto:info@coolockvillage.ie) with the subject **Meitheal security report**. Use a test installation and sample data.

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

The maintainer may ask for a shorter reproduction or more version details. Coordinate disclosure by email so that users can update or take protective action.

## Supported versions

Security fixes go into the current Stable release and the current Canary build. Meitheal is still on `0.0.x`, so update to the newest Stable release rather than expecting a backport to an older one. The [release notes](https://github.com/ryan-winkler/meitheal/releases) list what each release changes.

| Channel | Receives security fixes |
| --- | --- |
| Latest Stable release | Yes |
| Latest Canary build | Yes |
| Older releases | No. Update to the latest Stable release. |

## How the maintainer responds

1. **Acknowledge within 7 days.** You get a reply confirming receipt, usually much sooner. The initial response never takes more than 14 days.
2. **Assess.** The maintainer reproduces the problem on a test installation, rates its severity with CVSS, and tells you the outcome. A report that is not a vulnerability gets an explanation.
3. **Fix.** The maintainer prepares a fix privately, with a regression test where one can be written. The target is a fixed release within 60 days of the report for medium or higher severity, and as soon as possible for critical problems.
4. **Release and disclose.** The fix ships in a new release. The release notes name the vulnerability and any CVE or GitHub security advisory. A GitHub security advisory records the affected and fixed versions.
5. **Credit.** The advisory and release notes credit the reporter by the name they choose. Tell the maintainer if you prefer to stay anonymous.

If a fix needs longer than 60 days, the maintainer tells you why and agrees a disclosure date with you.

## What you can expect from Meitheal

The [security assurance case](docs/security-assurance-case.md) describes what Meitheal protects, the trust boundaries it relies on, and what it leaves to Home Assistant and to you.

## Verify a release image

Each Stable image published from GitHub Actions carries a signed build provenance attestation. The attestation is signed with a short-lived Sigstore certificate tied to this repository's release workflow, so there is no long-lived private key to obtain. To check that an image was built from this repository, run the [GitHub CLI](https://cli.github.com/) with the image's version and architecture:

```sh
gh attestation verify oci://ghcr.io/ryan-winkler/meitheal-amd64:VERSION --repo ryan-winkler/meitheal
```

Replace `amd64` with `aarch64` for ARM devices. Images published before attestations were added (0.0.1 and earlier) are verified by digest instead: compare the digest that Supervisor pulled with the digest in the App repository commit for that version.
