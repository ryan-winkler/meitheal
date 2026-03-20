---
description: How to generate, distribute, and manage Meitheal license keys
---

# License Key Management

## Generate a license key

// turbo
```bash
node scripts/generate-license.mjs --email <email> --plan <plan> --expires <YYYY-MM-DD>
```

- Plans: `personal`, `household`, `commercial`
- Omit `--expires` for a never-expiring key
- Output is a JWT string — share via email/DM

## Inspect an existing key

// turbo
```bash
node scripts/generate-license.mjs --inspect <token>
```

Shows header, payload, and expiry status. Does NOT verify signature (use the app for that).

## Verify in-app

// turbo
```bash
curl http://localhost:3000/api/license/status
```

Returns: `{ valid, plan, email, expiresAt, _source }`

## First-time keypair setup

Only needed once. If `.keys/meitheal-license.pem` already exists, skip this.

```bash
node scripts/generate-license.mjs --init
```

Then copy the printed public key into `packages/domain-auth/src/index.ts` → `LICENSE_PUBLIC_KEY_PEM`.

## Back up the private key

⚠️ If `.keys/meitheal-license.pem` is lost, ALL existing keys become unverifiable.

```bash
gopass insert -m ai/meitheal-license-key < .keys/meitheal-license.pem
```

## User setup

1. User receives JWT string
2. In HA: Settings → Add-ons → Meitheal → Configuration → License Key → paste JWT
3. Restart add-on
4. Check `/api/license/status` or add-on logs for validation result

## Key files

| File | Purpose |
|------|---------|
| `scripts/generate-license.mjs` | CLI keygen tool |
| `.keys/meitheal-license.pem` | Private key (gitignored) |
| `packages/domain-auth/src/index.ts` | `verifyLicenseKey()` + embedded public key |
| `apps/web/src/pages/api/license/status.ts` | License status API |
| `meitheal-hub/config.yaml` | `license_key: str?` option |
| `tests/e2e/license-key.spec.ts` | 11 unit tests |
