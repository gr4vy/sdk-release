# sdk-release

Shared release tooling for the six Gr4vy server-side SDKs. Each SDK repo pins these actions by commit SHA.

- `release-bot/`: runs after a PR's CI goes green. If the PR is a Speakeasy regeneration that passes the guard in `config/<sdk>.json`, the release bot App approves and merges it. Otherwise it labels the PR `needs-human` and says why.
- `publish-gate/`: runs after the live tests pass on `main`. It publishes when `.speakeasy/gen.lock` carries an untagged version. If every change since the last release was merged by the release bot, it publishes unattended. Otherwise a human approves it in the `release-manual` Environment.

## Guard rules

A PR merges unattended only when all of these hold:

- It was opened by `github-actions[bot]` on a `speakeasy-sdk-regen-*` branch in the same repo, against `main`.
- CI passed on the PR's head commit, and that push came from `speakeasy-github[bot]`.
- Every commit is attributed to Speakeasy.
- Every changed file is a generated path (`allowed`), and none is `blocked` or listed in the repo's `.genignore`. Blocked always wins.
- `versionOnly` files change nothing except version numbers, and only to the new `releaseVersion`.

To change a list, open a PR here, then bump the pinned SHA in the SDK repo. The bump touches `.github/`, so it always needs a human.

```bash
node --test 'test/*.test.mjs'
```

`test/fixtures/` holds real merged Speakeasy PRs from each SDK.
