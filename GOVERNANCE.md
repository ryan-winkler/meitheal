# Governance

Meitheal is a maintainer-led project. One maintainer, Ryan Winkler ([@ryan-winkler](https://github.com/ryan-winkler)), makes the final decision on what goes into the project. This file says who holds which role, how decisions are made, and what happens if the maintainer is unavailable.

## Roles

| Role | Who |
| --- | --- |
| Maintainer | Ryan Winkler ([@ryan-winkler](https://github.com/ryan-winkler)), listed in [CODEOWNERS](.github/CODEOWNERS) |
| Contributor | Anyone who opens an issue, a discussion, or a pull request |
| Automated reviewer | CodeRabbit, CodeQL, Codacy, OpenSSF Scorecard, Dependabot |

The maintainer:

- sets direction and keeps the [roadmap](ROADMAP.md) current;
- reviews and merges pull requests, and triages issues;
- handles private [security reports](SECURITY.md) and [conduct reports](CODE_OF_CONDUCT.md);
- cuts releases and publishes images;
- administers this repository, its secrets, the [App repository](https://github.com/ryan-winkler/meitheal-ha-addon), and the container packages.

A contributor follows [CONTRIBUTING.md](CONTRIBUTING.md) and the [code of conduct](CODE_OF_CONDUCT.md), signs the [contributor agreement](.github/CLA.md) before a pull request is merged, and keeps credentials and household data out of public reports.

Automated reviewers report findings on pull requests and on the default branch. They inform decisions but never approve or merge.

The maintainer can add maintainers. A new maintainer has had several pull requests merged over at least three months and agrees to the maintainer duties above. Their name and GitHub account are added to this file and to CODEOWNERS in the same pull request that grants access.

## How decisions are made

- **Everyday changes** (bug fixes, documentation, small UI changes) are decided in the pull request. The maintainer merges once the [review standard](CONTRIBUTING.md#code-review-standard) is met, including the self-review comment for the maintainer's own changes, and the required checks pass.
- **New capabilities, public APIs, default interactions, and data migrations** start with an issue so the design can be discussed before code is written. Architectural decisions are recorded as [decision records](docs/decisions/index.md).
- **Security, licensing, and release infrastructure** are decided by the maintainer, with the reasoning recorded in the pull request or a decision record.
- **Disagreements** are discussed in the issue or pull request. The maintainer makes the final call and explains it in writing.

The [roadmap](ROADMAP.md) is reviewed when a release is cut, and at least once every six months.

## Access and continuity

The maintainer account uses two-factor authentication. Anyone given write access must enable it first, using a passkey, hardware security key, or authenticator app rather than SMS.

Until there is a second maintainer, only Ryan Winkler can publish releases, images, or App repository updates. The source, history, and issues are public, so if the maintainer stops responding, anyone can fork the source repository and continue it under a distinct name under the [source license](LICENSE) and [notices](NOTICE) (see [commercial licensing](COMMERCIAL.md); published release images carry separate distribution terms). The project is looking for a second maintainer with administrator access. To help, start with an issue labelled [`good first issue`](https://github.com/ryan-winkler/meitheal/labels/good%20first%20issue) or [email the maintainer](mailto:hi@ryanw.eu).

## Changing this document

Changes to governance are made by pull request and merged by the maintainer.
