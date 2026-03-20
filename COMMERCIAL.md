# Commercial Licensing — Meitheal

> **Meitheal is open source.** The core platform is licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0). You are free to use, modify, and self-host Meitheal for any purpose — personal, educational, non-profit, or commercial — as long as you comply with the AGPL's requirements.

## When Do You Need a Commercial License?

If your organization **cannot or does not want to** comply with the AGPL-3.0 obligations, a commercial license is available. Common scenarios:

| Scenario | AGPL-3.0 | Commercial License |
|----------|----------|--------------------|
| Self-hosting for your own household / homelab | ✅ Free | Not needed |
| Contributing to the open-source project | ✅ Free | Not needed |
| Building plugins/integrations via the REST/WebSocket/MCP APIs | ✅ Free (API Exception) | Not needed |
| Hosting Meitheal as a service for others (SaaS) | ⚠️ Must open-source your full stack | ✅ Removes copyleft |
| Embedding Meitheal in proprietary software | ⚠️ Must open-source the combined work | ✅ Removes copyleft |
| OEM / white-label distribution | ⚠️ Must open-source | ✅ Removes copyleft |

## API / Plugin Exception

Interacting with Meitheal **strictly via its published APIs** (REST, WebSocket, MCP) does not constitute creating a derivative work. You are free to build external clients, webhooks, plugins, and integrations under any license you choose.

This exception does not cover embedding, linking, or including Meitheal source code directly in your software.

## What's Included in a Commercial License?

- Permission to use, modify, and distribute Meitheal without AGPL copyleft obligations
- Priority support and SLA options (negotiable)
- Access to the same codebase — no "enterprise edition" fork

## What's Excluded?

The `apps/web/src/domains/integrations/vikunja-compat/` directory contains code that interoperates with [Vikunja](https://vikunja.io/) (AGPL-3.0). Because we do not own Vikunja's copyright, this module **cannot be relicensed** under a commercial license. Commercial licensees receive the Meitheal core under proprietary terms, but the Vikunja compatibility layer remains governed by the AGPL-3.0.

If you need an alternative to the Vikunja adapter, our team can help you build a proprietary replacement.

## Contributor License Agreement (CLA)

To maintain the ability to offer dual licensing, all contributors must sign our [Contributor License Agreement](.github/CLA.md) before their first pull request can be merged. The CLA grants Ryan Winkler (the project maintainer) the rights needed to offer Meitheal under both the AGPL and commercial terms. Contributors retain copyright to their contributions.

## Contact

For commercial licensing inquiries:

- **Email**: licensing@coolockvillage.ie
- **GitHub**: [Coolock Village Discussions](https://github.com/orgs/Coolock-Village/discussions)

---

*This document is not a license itself. It describes the licensing options available. The actual licenses are the [AGPL-3.0](LICENSE) and individually negotiated commercial agreements.*
