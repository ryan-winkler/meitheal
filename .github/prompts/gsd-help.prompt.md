---
description: "Run the GSD help workflow for this repository from VS Code Copilot"
---

# GSD: help

Read and execute the installed GSD workflow for this repository.

Work from repository root where `.planning/` lives.

Read:

```bash
cat "$HOME/.config/opencode/get-shit-done/workflows/help.md"
```

Follow all steps in the workflow file exactly as documented.
Use `node "$HOME/.config/opencode/get-shit-done/bin/gsd-tools.cjs"` for GSD tool commands when the workflow calls for them.
If the workflow file is missing, stop and tell the user to install GSD for Copilot or restore the existing global install before continuing.