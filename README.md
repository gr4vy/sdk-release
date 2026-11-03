# sdk-release

Shared release tooling for the six Gr4vy server-side SDKs. Each SDK repo pins these actions by commit SHA.

- `release-bot/`: runs after a PR's CI goes green. If the PR is a Speakeasy regeneration that passes the guard in `config/<sdk>.json`, the gr4vy-sdk-release App approves and merges it. Otherwise it labels the PR `needs-human` and says why.
- `publish-gate/`: runs after the live tests pass on `main`. It publishes when `.speakeasy/gen.lock` carries an untagged version. If every change since the last release was merged by the gr4vy-sdk-release App or came from a Dependabot PR, it publishes unattended. A Dependabot PR counts only when it was opened by `dependabot[bot]` from a `dependabot/` branch in the same repo, which the SDK repos lock to Dependabot's own pushes. Otherwise a human approves it in the `release-manual` Environment.

## Guard rules

A PR merges unattended only when all of these hold:

- It was opened by the config's `prAuthor` on a `speakeasy-sdk-regen-*` branch in the same repo, against `main`. That's the gr4vy-sdk-generate App once an SDK hands Speakeasy its token, and `github-actions[bot]` before that.
- CI passed on the PR's head commit, and that push came from one of the config's `pushActors`.
- Every commit is attributed to Speakeasy.
- Every changed file is a generated path (`allowed`), and none is `blocked` or listed in the repo's `.genignore`. Blocked always wins.
- `versionOnly` files change nothing except version numbers, and only to the new `releaseVersion`.
- `manifests` (such as `package.json`) may change only `version`, to the new `releaseVersion`, and the version ranges of dependencies already listed. Adding or removing a dependency, or changing any other field such as `scripts`, goes to a human. Lockfiles are treated as generated output.

To change a list, open a PR here, then bump the pinned SHA in the SDK repo. The bump touches `.github/`, so it always needs a human.

```bash
node --test 'test/*.test.mjs'
```

`test/fixtures/` holds real merged Speakeasy PRs from each SDK. TypeScript's has its author changed to the gr4vy-sdk-generate App and Speakeasy's empty CI-trigger commit removed, until an App PR merges unattended and replaces it. `typescript-new-gen-flag.json` is the App's first real PR (#373), which went to a human because Speakeasy added a setting to `gen.yaml`.
