---
type: "Runbook"
title: "Licensing & Distribution — KCS Runbook"
description: "Find the license boundaries for source, integrations, and distribution."
---

# Licensing & Distribution — KCS Runbook

## Source and published images

The source repository contains the application, integration code, and release workflow. The [public add-on repository](https://github.com/ryan-winkler/meitheal-ha-addon) contains the Store manifests and [image distribution license](https://github.com/ryan-winkler/meitheal-ha-addon/blob/main/LICENSE).

| Material | Where to check its terms |
| --- | --- |
| Application source | [Source license](../../LICENSE) and [commercial licensing](../../COMMERCIAL.md) |
| Documentation | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| Historical compatibility component | Separately licensed and outside the current release |
| Integration code | License files in [integrations](../../integrations/) |

## License Key Operations

### Generate a key

```bash
node scripts/generate-license.mjs --email user@example.com --plan personal --expires 2027-01-01
```

Plans: `personal`, `household`, `commercial`

### Inspect a key

```bash
node scripts/generate-license.mjs --inspect eyJhbGci...
```

Keep an encrypted backup of the private signing key outside the repository. Replacing the key invalidates existing licenses and requires a separate maintainer procedure.

## App Store publication

The [release workflow](releasing.md) uses `ADDON_REPO_TOKEN` after both App images pass anonymous pull verification. Scope the fine-grained token to **Contents: Read and write** in `ryan-winkler/meitheal-ha-addon`.

## GHCR Package Visibility

Existing GHCR packages **keep their visibility** when the source repo goes private. Only brand-new packages from a private repo default to private.

Check the [maintainer’s packages](https://github.com/ryan-winkler?tab=packages).

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| App Store promotion fails | Missing/expired `ADDON_REPO_TOKEN` | Regenerate PAT, update secret |
| `verifyLicenseKey` returns `invalid_signature` | Key generated with different keypair | Re-issue key with current `.keys/` |
| `verifyLicenseKey` returns `expired` | JWT `exp` claim in the past | Generate new key with later `--expires` |
| GHCR images not pullable | Package went private | Check access and pull the exact version without a registry login |
| User can't find add-on | Wrong repo URL | Check the current public repository in the [setup guide](../../meitheal-hub/DOCS.md) |
