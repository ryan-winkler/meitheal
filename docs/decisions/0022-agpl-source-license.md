---
type: "Decision"
title: "ADR 0022: AGPL-3.0-only Source License with Commercial Licensing"
description: "Replaces the custom source-available license with AGPL-3.0-only and keeps commercial licensing through the contributor agreement."
---

# ADR 0022: AGPL-3.0-only Source License with Commercial Licensing

Date: 2026-11-14
Status: Accepted. Supersedes [ADR 0013](0013-dual-licensing-strategy.md).

## Context

Meitheal used a custom license, `LicenseRef-Meitheal-Source-Available-1.0`. License scanners could not match it to an SPDX identifier. It was neither OSI-approved nor FSF-free, so it did not meet the OpenSSF Best Practices `floss_license` criterion or the Scorecard `hasFSFOrOSIApprovedLicense` probe.

No license that bans third-party sales or hosting is OSI- or FSF-approved. The project had to choose between that ban and the OpenSSF criteria.

## Decision

- License Meitheal-owned source and artwork under `AGPL-3.0-only`. `LICENSE` holds the unmodified FSF text so scanners recognise it. Copyright and the license statement are in `NOTICE`.
- Offer separate commercial licenses for distributing or hosting modified versions without the AGPL source offer, and for proprietary embedding. Each needs a written agreement with the maintainer. [COMMERCIAL.md](../../COMMERCIAL.md) explains the route.
- The [contributor agreement](../../.github/CLA.md) lets the maintainer distribute contributions under AGPL-3.0-only and under separate commercial terms, including official binary images.
- Keep `org.opencontainers.image.licenses=LicenseRef-Proprietary` on official images. The maintainer distributes those under separate terms.
- Keep the Apache-2.0 integrations, the CC BY 4.0 documentation, and third-party notices unchanged.
- Ask for security fixes, bug fixes, and improvements to be sent upstream. This is an expectation, not a license condition. A separate program that only talks to Meitheal through its network APIs can stay private.

## Consequences

- Scanners report `AGPL-3.0-only`, and the OpenSSF FLOSS license criteria are met.
- Anyone who modifies Meitheal and distributes it or runs it as a network service must give their users the complete source under AGPL-3.0-only. Others may sell or host Meitheal under those terms. The license does not prohibit that. The trademark and commercial licensing remain the controls on closed or official-looking offerings.
- Paid installation and setup are allowed when the recipient also receives the source and license.
- Copies already received under the earlier license keep that grant.
