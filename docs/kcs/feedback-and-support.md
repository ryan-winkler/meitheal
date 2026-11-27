---
type: Runbook
title: Feedback and support
description: Find help, submit public feedback and preserve older installation reports.
---

# Feedback and support

Open **Settings → App & Companion → Help & Support**. **GitHub Issues** opens the issue form for reproducible bugs. Use **GitHub Discussions** for questions and suggestions, and **Guides** for setup and usage. These links open in a new tab. [Support guide](../../SUPPORT.md).

For a suspected vulnerability, use **Report a security vulnerability privately** in the same card. [Security policy](../../SECURITY.md).

## Older installation reports

The Settings form and local queue have been removed. Older reports remain in the installation database. A verified Home Assistant administrator can take a cold App backup or use **Settings → Backups & Reset → Data Portability → Raw DB**. Treat both backups as private household data. The existing local API continues to enforce Home Assistant role and same-origin checks. [Backup and restore](home-assistant-backup-and-restore.md).

## Verification

Run the built browser check for Settings support links in `tests/e2e/feedback-ingress.spec.ts`. Check that the GitHub buttons appear once for members and administrators on narrow screens. The existing API tests in that spec and `tests/e2e/feedback.spec.ts` verify access to existing records independently of Settings.
