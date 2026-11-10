---
type: "Guide"
title: "Webhook Setup Guide"
description: "Connect an external automation receiver."
---

# Webhook Setup Guide

## Quick Start (5 Steps)

1. **Add subscriber** to `integrations.yaml`:

   ```yaml
   webhooks:
     - id: my-n8n
       url: https://your-n8n.example.com/webhook/meitheal
       secret: your-hmac-secret-here
       events: ["task.created", "framework.score.applied"]
       enabled: true
   ```

2. **Generate a secret:** `openssl rand -hex 32`
3. **Configure your receiver** to verify `X-Meitheal-Signature` header
4. **Restart Meitheal** — config validates on startup
5. **Create a task** — your endpoint receives the webhook

## Event Catalog

| Event | Payload | When |
|-------|---------|------|
| `task.created` | `{ taskId, title, frameworkFields }` | New task created |
| `task.updated` | `{ taskId, changes }` | Task modified |
| `framework.score.applied` | `{ taskId, scores }` | Framework scoring runs |
| `integration.sync.requested` | `{ taskId, target }` | Calendar sync requested |
| `integration.sync.completed` | `{ taskId, result }` | Calendar sync finished |
| `webhook.delivery.failed` | `{ deliveryId, subscriberId, error }` | Delivery failed (not re-emitted) |

## Signature Verification

All webhooks include `X-Meitheal-Signature: sha256={hex}`.

### Node.js

```javascript
const crypto = require('crypto');

function verifyWebhook(secret, payload, signature) {
  const expected = 'sha256=' + crypto.createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(expected), Buffer.from(signature)
  );
}
```

### Python

```python
import hmac, hashlib

def verify_webhook(secret: str, payload: bytes, signature: str) -> bool:
    expected = 'sha256=' + hmac.new(
        secret.encode(), payload, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, signature)
```

## Headers

| Header | Value |
|--------|-------|
| `X-Meitheal-Signature` | `sha256={hmac-hex}` |
| `X-Meitheal-Event` | Event type (e.g. `task.created`) |
| `X-Meitheal-Delivery-Id` | Unique delivery UUID (for deduplication) |

## Retry Behavior

- 3 attempts: immediate, +1s, +4s, +16s
- Retries on: 429, 5xx, timeout
- No retry on: 4xx (except 429), network errors
- Failed deliveries stored in dead letter queue

## Secret Rotation (OA-205)

To rotate a webhook secret without delivery gaps:

1. Add new secret as `new_secret` in subscriber config
2. During transition window, verify against both secrets
3. Remove old secret after confirming delivery with new secret

## Troubleshooting

- **Signature mismatch**: Verify your endpoint receives raw body (not parsed JSON)
- **Timeouts**: Default 10s per delivery — check receiver response time
- **Dead letter replay**: GET `/api/admin/webhooks/dead-letter` (requires admin auth)

## HA Network Note (FR-203)

When Grocy runs as a separate HA add-on, ensure both add-ons share a Docker network:

```yaml
# In Grocy add-on config
network:
  - meitheal_net
```

---

*Last updated: 2026-02-28 — Phase 2 Integration Deepening*


## Local development TLS

Use a trusted certificate for webhook delivery in production. In development, an actual `.internal` hostname can use a request-scoped TLS exception. A compatibility wrapper connects the development dispatcher to Node’s built-in fetch. The request rejects redirects so the exception cannot move to another host. The dispatcher closes after the response body is consumed or cancelled. An external URL containing `.internal` in its path or query does not qualify for the exception.
