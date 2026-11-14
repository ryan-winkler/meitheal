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

To run the full suite as CI does, run `pnpm --filter @meitheal/web build` and then `pnpm --filter @meitheal/tests test:ci`. The runner starts a fresh server and database for each spec. [Test fixture and troubleshooting](docs/kcs/ci-test-determinism.md).

A local Astro check covers web behavior. Changes to ingress, Supervisor, Home Assistant integration or sync, and App lifecycle need the Home Assistant devcontainer. Confirm real-device claims on supported hardware and record the exact versions tested. [Home Assistant devcontainer runbook](docs/kcs/home-assistant-devcontainer.md) · [Release runbook](docs/kcs/releasing.md).

## Submit a pull request

Target pull requests and automated pushes to `dev` (the primary branch). Keep `main` (beta channel, mostly unused) and `release` (full production release) reserved for explicit maintainer promotions, and keep version increments on `0.0.<single-digit>` (`+0.0.1` only when cutting a release).

1. Explain the observed behavior, expected result, and affected domain. Link related issues and credit reused work. Keep applicable license notices.
2. List the commands and results. For a UI change, show the affected state and explain how you checked keyboard use. For migration or compatibility changes, describe what happens to existing installations.
3. Update the owning documentation. State which checks you skipped and why. Keep credentials, household data, and unredacted logs or captures out of the pull request.
4. Get maintainer review. Address CodeRabbit findings or explain the rationale for declining them.

Use descriptive commit messages. Keep release commands in the [release runbook](docs/kcs/releasing.md).

## Coding standards

Contributions must follow these style guides. CI checks the compiler settings on every push and pull request and fails on errors. Codacy reports findings on pushes and on pull requests from this repository; it does not block a merge, and the reviewer reads its findings and asks for fixes.

| Language | Standard | How it is checked |
| --- | --- | --- |
| TypeScript and Astro | The strict compiler settings in [tsconfig.base.json](tsconfig.base.json) (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), the [Astro project structure](https://docs.astro.build/en/basics/project-structure/), and the patterns in [client-side patterns](docs/kcs/client-side-patterns.md) and [DESIGN.md](DESIGN.md) | `tsc --noEmit` for each package and `astro check` in [CI](.github/workflows/ci.yml); ESLint and Semgrep rules in [Codacy](.github/workflows/codacy.yml) |
| Python (Home Assistant integration) | [PEP 8](https://peps.python.org/pep-0008/), type hints, and the [Home Assistant development guidelines](https://developers.home-assistant.io/docs/development_guidelines) | Pylint, Prospector and Bandit in Codacy; pytest against two Home Assistant Core releases in CI |
| GitHub Actions | Actions pinned to a full commit SHA, least-privilege `permissions`, and no untrusted input in `run:` steps | CodeQL and OpenSSF Scorecard |
| Documentation | Plain, short sentences. Pages under `docs/` carry front matter and appear in an index, except `log.md` files and non-root `index.md` files, which must not have front matter | The docs bundle test in [tests/governance](tests/governance) |

## Test policy

Every change in the *new capability, public API, default interaction, or migration* row of [Choose a starting point](#choose-a-starting-point) must add automated tests for that functionality in the same pull request. Every bug fix must add a regression test that fails without the fix, unless the pull request explains why one cannot be written. Pull requests without the required tests are not merged.

- Web and API behavior: Playwright specs in [tests/e2e](tests/e2e), run in CI against a fresh server and database for each spec.
- Pure functions and parsers: Playwright unit specs in [tests/unit](tests/unit).
- Repository rules and release contracts: specs in [tests/governance](tests/governance).
- Home Assistant integration: pytest in [integrations/home-assistant/tests](integrations/home-assistant/tests).

Coverage is reported to [Codecov](https://codecov.io/gh/ryan-winkler/meitheal) for TypeScript and Python. Codecov flags pull requests whose new and changed lines fall below 80% coverage ([codecov.yml](codecov.yml)). Coverage is not reported for pull requests from forks. The reviewer decides whether a gap is acceptable.

## Code review standard

Every pull request is reviewed before it is merged. The maintainer reviews pull requests from contributors. When the project has more than one maintainer, a maintainer's own pull request is reviewed by a different maintainer; until then the maintainer reviews their own change against this list after the automated review finishes. Automated review (CodeRabbit, CodeQL, Codacy) supports human review but does not replace it.

The reviewer checks that:

1. The change solves the stated problem and fits the [roadmap](ROADMAP.md) and the owning domain.
2. CI, CodeQL code scanning, dependency review and the CLA check pass.
3. Tests follow the [test policy](#test-policy) and the commands listed in the pull request were actually run.
4. Inputs from users, Home Assistant, integrations and agents are validated, access checks cover every new endpoint, and no secrets or household data appear in code, logs or fixtures.
5. Existing installations keep working: migrations are tested, settings survive upgrades, and nothing is removed without a replacement and a migration path.
6. User-facing changes work by keyboard, meet contrast requirements, and update the owning documentation.
7. New dependencies are necessary, maintained, and licensed compatibly.

A change is acceptable when every point is met or the pull request explains why a point does not apply. A reviewer who is not the author records approval as a GitHub review. When the maintainer merges their own pull request, they first post a comment confirming the checklist above. The maintainer then merges.

## Find a first task

Issues labelled [`good first issue`](https://github.com/ryan-winkler/meitheal/labels/good%20first%20issue) are small, self-contained tasks for new or casual contributors. Issues labelled [`help wanted`](https://github.com/ryan-winkler/meitheal/labels/help%20wanted) need more context but welcome outside help.

## Contributor License Agreement

Read the [source license](LICENSE) and [contributor agreement](.github/CLA.md). They explain how your changes may be included and distributed. You retain copyright to your work.

Before a pull request can be merged, follow the CLA prompt on the pull request. Read the agreement and reply to the prompt with the exact signing phrase below.

> I have read the CLA Document and I hereby sign the CLA.

GitHub must associate each commit with its author’s account. If you open the pull request, include a commit under your own GitHub identity. Keep each pull request within 250 commits so the check covers the full contribution. Comment `recheck` to refresh the CLA status after a failed check.

Offer changes through a pull request or contact the maintainer. Include a patch or branch and the steps needed to verify it. If you use automated tools, verify the change, check the source and license of any reused material, and test the result from the user’s perspective. For questions, bug reports, and private security disclosure, see [Support](SUPPORT.md).
