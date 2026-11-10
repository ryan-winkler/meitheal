# Contributing to Meitheal

You can help with documentation, accessibility, bug fixes, and integrations. Start with the smallest change that solves the problem. Check for an existing issue or upstream fix before opening a new one.

## Choose a starting point

| Work | Where to start | Evidence to include |
| --- | --- | --- |
| Copy, translation, documentation, or a small UI fix | Open a focused pull request | Check affected links or show the changed UI. |
| Reproducible bug in one area | Link an issue or include steps in the pull request | Show the failure and the fix. Cover existing data when the change affects it. |
| New capability, public API, default interaction, or migration | Open an issue and discuss it with a maintainer first | Describe the user outcome, owning code, compatibility, migration, and acceptance checks. |
| Security, permissions, licensing, release infrastructure, or sensitive data | Use private reporting for an undisclosed vulnerability. Discuss other changes with the [code owner](.github/CODEOWNERS) | Record the decision, affected trust boundaries, and verification with the responsible maintainer. [Security policy](SECURITY.md). |

Keep discussion respectful and focused on the work. Use invented examples when a real household, device, or installation would expose personal information.

## Find the owning code

| Change | Start here |
| --- | --- |
| Web pages, UI, Settings, search, or API routes | [Astro app](apps/web) |
| Task behavior, strategy, authentication, or observability rules | [Domain packages](packages) |
| Integration adapters and delivery | [Integration core](packages/integration-core) and [integration clients](integrations) |
| Home Assistant App startup, permissions, or packaging | [Stable App](meitheal-hub), [canary App](meitheal-hub-canary), and [repository manifest](repository.yaml) |
| Regression or compatibility checks | [Tests](tests) |
| User help, runbooks, or design decisions | [Documentation index](docs/index.md) |

Prefer Astro and native browser behavior where they fit. Keep domain rules with their owning context, use public package APIs across contexts, and reuse existing behavior before adding another abstraction. Update the relevant support guide with any behavior change, and record architectural decisions in [docs/decisions](docs/decisions).

## Run and verify locally

Use a current Node.js 22 patch release and the pnpm version in [package.json](package.json). Run the following commands from the repository root.

```sh
pnpm install --frozen-lockfile
test_data="$(mktemp -d)"
MEITHEAL_DB_URL="file:$test_data/meitheal.db" pnpm --filter @meitheal/web dev --host 127.0.0.1 --port 3000
```

Open `http://127.0.0.1:3000`. This starts a local Astro instance with a disposable database. Stop the server when finished.

In a separate shell, run the package checks and an affected regression spec. For browser changes, install Chromium for the locked Playwright version and run the relevant spec against the local instance.

```sh
pnpm check
pnpm --filter @meitheal/tests test e2e/ingress-header-validation.spec.ts
pnpm --filter @meitheal/tests exec playwright install chromium
E2E_BASE_URL=http://127.0.0.1:3000 pnpm --filter @meitheal/tests test e2e/pages.spec.ts
```

To run the suite against the isolated production build used by CI, run `pnpm --filter @meitheal/web build` and then `MEITHEAL_TEST_BROWSER=1 pnpm --filter @meitheal/tests test`. [Test fixture and troubleshooting](docs/kcs/ci-test-determinism.md).

A local Astro check covers web behavior. Changes to ingress, Supervisor, Home Assistant integration or sync, and App lifecycle need the Home Assistant devcontainer. Confirm real-device claims on supported hardware and record the exact versions tested. [Home Assistant devcontainer runbook](docs/kcs/home-assistant-devcontainer.md) · [Release runbook](docs/kcs/releasing.md).

## Submit a pull request

1. Explain the observed behavior, expected result, and affected domain. Link related issues and credit reused work. Keep applicable license notices.
2. List the commands and results. For a UI change, show the affected state and explain how you checked keyboard use. For migration or compatibility changes, describe what happens to existing installations.
3. Update the owning documentation. State which checks you skipped and why. Keep credentials, household data, and unredacted logs or captures out of the pull request.
4. Get maintainer review. Address CodeRabbit findings or explain the rationale for declining them.

Use descriptive commit messages. Keep release commands in the [release runbook](docs/kcs/releasing.md).

## Contributor License Agreement

Read the [source license](LICENSE) and [contributor agreement](.github/CLA.md). They explain how your changes may be included and distributed. You retain copyright to your work.

Before a pull request can be merged, follow the CLA prompt on the pull request. Read the agreement and reply to the prompt with the exact signing phrase below.

> I have read the CLA Document and I hereby sign the CLA.

GitHub must associate each commit with its author’s account. If you open the pull request, include a commit under your own GitHub identity. Keep each pull request within 250 commits so the check covers the full contribution. Comment `recheck` to refresh the CLA status after a failed check.

Offer changes through a pull request or contact the maintainer. Include a patch or branch and the steps needed to verify it. Follow the [automation policy](AI_POLICY.md) when you use automated tools. For questions, bug reports, and private security disclosure, see [Support](SUPPORT.md).
