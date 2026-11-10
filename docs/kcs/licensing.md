# Licensing & Distribution — KCS Runbook

## Architecture

```
Coolock-Village/meitheal (PRIVATE)     Coolock-Village/meitheal-ha-addon (PUBLIC)
├── apps/, packages/                    ├── repository.yaml
├── meitheal-hub/              ──CI──→  ├── meitheal-hub/{config,DOCS,CHANGELOG,icons,translations}
├── meitheal-hub-canary/       ──CI──→  ├── meitheal-hub-canary/{...}
├── .github/workflows/                  ├── LICENSE (Proprietary)
│   └── sync-addon-repo.yml             ├── COMMERCIAL.md
├── .keys/meitheal-license.pem          └── README.md
└── scripts/generate-license.mjs
```

## License Strategy

| What | License |
|------|---------|
| Source code | AGPL-3.0 + Commercial (dual) |
| Docker images | Proprietary distribution |
| Vikunja compat | AGPL-3.0 only |
| Integration code (`integrations/`) | Apache 2.0 |

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

### Regenerate keypair (⚠️ invalidates ALL existing keys)

```bash
rm -rf .keys/
node scripts/generate-license.mjs --init
# Update LICENSE_PUBLIC_KEY_PEM in packages/domain-auth/src/index.ts
```

### Back up private key

```bash
gopass insert -m ai/meitheal-license-key < .keys/meitheal-license.pem
```

## CI Sync Workflow

**File**: `.github/workflows/sync-addon-repo.yml`

**Trigger**: pushes to `main` touching `repository.yaml`, `meitheal-hub/**`, or `meitheal-hub-canary/**`

**Requires**: `ADDON_REPO_TOKEN` secret (fine-grained PAT → `meitheal-ha-addon` → Contents write)

**Creates PAT**: GitHub Settings → Developer Settings → Fine-grained tokens → Resource owner: Coolock-Village → Only `meitheal-ha-addon` → Contents: Read and write

## GHCR Package Visibility

Existing GHCR packages **keep their visibility** when the source repo goes private. Only brand-new packages from a private repo default to private.

Check: https://github.com/orgs/Coolock-Village/packages

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Sync workflow fails | Missing/expired `ADDON_REPO_TOKEN` | Regenerate PAT, update secret |
| `verifyLicenseKey` returns `invalid_signature` | Key generated with different keypair | Re-issue key with current `.keys/` |
| `verifyLicenseKey` returns `expired` | JWT `exp` claim in the past | Generate new key with later `--expires` |
| GHCR images not pullable | Package went private | Set to public at org packages page |
| User can't find add-on | Wrong repo URL | Must use `Coolock-Village/meitheal-ha-addon` |

## License verification tests

License regressions generate an ephemeral Ed25519 issuer in memory and pass
its public key explicitly to `verifyLicenseKey`. Production calls omit this
argument and retain the embedded verification key; a regression verifies that
the default verifier rejects the ephemeral issuer. CI never reads or publishes
`.keys/meitheal-license.pem`. Wrong-key, issuer and expiry checks still exercise
the actual cryptographic verifier.
