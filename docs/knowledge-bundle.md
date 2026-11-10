---
type: Reference
title: Documentation bundle
description: Scope and maintenance of the Meitheal documentation bundle.
---

# Documentation bundle

Every Markdown file under `docs/` is part of the bundle. Its path relative to `docs/`, without the `.md` suffix, is its concept ID. Guides, decision records, and research retain their existing paths. Images and editor settings are supporting files. Repository policies and App manuals outside `docs/` belong to separate collections.

Give each concept YAML frontmatter with a nonempty `type`, and add an entry to the nearest `index.md` so readers can find it. Use Git history to track edits. Cite the original source when documenting a decision or external requirement. [Open Knowledge Format 0.2 specification](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/ad30107c31c06aec8a7d5636e0d1058118604e6f/SPEC.md).

Run the bundle check from the repository root.

```sh
pnpm --filter @meitheal/tests test governance/docs-okf.spec.ts
```
