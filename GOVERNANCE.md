# Governance

Meitheal is a maintainer-led project. One maintainer, Ryan Winkler ([@ryan-winkler](https://github.com/ryan-winkler)), currently makes the final decision on what goes into the project. This file says who holds which role, how decisions are made, and how the project continues if the maintainer cannot.

## Roles

| Role | Who | Responsibilities |
| --- | --- | --- |
| Maintainer | Ryan Winkler ([@ryan-winkler](https://github.com/ryan-winkler)) | Sets direction and the [roadmap](ROADMAP.md). Reviews and merges pull requests. Triages issues. Handles private [security reports](SECURITY.md) and [conduct reports](CODE_OF_CONDUCT.md). Cuts releases and publishes images. Administers the repository, its secrets, and the App repository. Listed in [CODEOWNERS](.github/CODEOWNERS). |
| Contributor | Anyone who opens an issue, a discussion, or a pull request | Follows [CONTRIBUTING.md](CONTRIBUTING.md) and the [code of conduct](CODE_OF_CONDUCT.md). Signs the [contributor agreement](.github/CLA.md) before a pull request is merged. Keeps credentials and household data out of public reports. |
| Automated reviewers | CodeRabbit, CodeQL, Codacy, OpenSSF Scorecard, Dependabot | Report findings on pull requests and on the default branch. They inform decisions and never approve or merge on their own. |

The maintainer can add maintainers. A new maintainer is someone who has made sustained, high-quality contributions and agrees to the responsibilities above. Their name and GitHub account are added to the table above and to CODEOWNERS in the same pull request that grants access.

## How decisions are made

- **Everyday changes** (bug fixes, documentation, small UI changes) are decided in the pull request. The maintainer merges once the [review standard](CONTRIBUTING.md#code-review-standard) is met and the required checks pass.
- **New capabilities, public APIs, default interactions, and data migrations** start with an issue so the design can be discussed before code is written. Architectural decisions are recorded as [decision records](docs/decisions/index.md).
- **Security, licensing, and release infrastructure** are decided by the maintainer, with the reasoning recorded in the pull request or a decision record.
- **Disagreements** are discussed in the issue or pull request. The maintainer makes the final call and explains it in writing.

The [roadmap](ROADMAP.md) is reviewed when a release is cut, and at least once every six months.

## Access and continuity

The maintainer holds administrator access to this repository, the [App repository](https://github.com/ryan-winkler/meitheal-ha-addon), the GitHub Container Registry packages, and the repository secrets. Every account with write access must use two-factor authentication. Passkeys, hardware security keys, or authenticator apps are preferred over SMS.

The source, history, issues, and release images are public, so anyone can fork and continue the project under the [license](LICENSE) if the maintainer stops. To keep the official project running without interruption, the project is looking for a second maintainer with administrator access. Until then the bus factor is one. If you would like to help maintain Meitheal, start with an issue labelled [`good first issue`](https://github.com/ryan-winkler/meitheal/labels/good%20first%20issue) or contact the maintainer.

## Changing this document

Changes to governance are made by pull request and merged by the maintainer.
