import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evaluate, evaluateRelease, isVersionBumpTo, checkManifest, isDependencyBump, isDowngrade } from '../guard/guard.mjs';
import { matchesAny } from '../guard/glob.mjs';
import { loadConfig } from '../guard/config.mjs';

const SDKS = ['typescript', 'python', 'java', 'go', 'php', 'csharp', 'java-connectors'];

function load(sdk, fixture = sdk) {
  const fx = JSON.parse(readFileSync(new URL(`fixtures/${fixture}.json`, import.meta.url)));
  const config = loadConfig(fileURLToPath(new URL(`../config/${sdk}.json`, import.meta.url)));
  const pr = { ...fx.pr, state: 'open' };
  const run = { head_sha: pr.head.sha, event: 'pull_request', conclusion: 'success', actor: { login: config.pushActors[0] } };
  return { pr, run, commits: fx.commits, files: fx.files, genignore: fx.genignore, config };
}

function withFile(input, file) {
  return { ...input, pr: { ...input.pr, changed_files: input.pr.changed_files + 1 }, files: [...input.files, file] };
}

for (const sdk of SDKS.filter((s) => s !== 'csharp')) {
  test(`${sdk}: a real Speakeasy PR merges unattended`, () => {
    assert.deepEqual(evaluate(load(sdk)), { ok: true, reasons: [] });
  });
}

test('csharp: the tri-state patch commit sends the PR to a human', () => {
  const { ok, reasons } = evaluate(load('csharp'));
  assert.equal(ok, false);
  assert.deepEqual(reasons, [reasons.find((r) => /^commit \w+ by github-actions\[bot\]$/.test(r))]);
});

test('csharp: the tri-state patch merges when the generate App commits it', () => {
  const input = load('csharp');
  const app = { login: 'gr4vy-sdk-generate[bot]' };
  const commits = input.commits.map((c) => (c.author.login === 'github-actions[bot]' ? { ...c, author: app, committer: app } : c));
  assert.deepEqual(evaluate({ ...input, commits }), { ok: true, reasons: [] });
});

test('only C# trusts commits from the generate App', () => {
  for (const sdk of SDKS.filter((s) => s !== 'csharp')) {
    assert.ok(!load(sdk).config.commitAuthors.includes('gr4vy-sdk-generate[bot]'), sdk);
  }
});

test('a push by anyone but Speakeasy goes to a human', () => {
  const input = load('typescript');
  const { ok, reasons } = evaluate({ ...input, run: { ...input.run, actor: { login: 'mallory' } } });
  assert.equal(ok, false);
  assert.match(reasons[0], /latest push was by mallory/);
});

for (const sdk of SDKS) test(`${sdk}: only gr4vy-sdk-generate may open and push a Speakeasy PR`, () => {
  const input = load(sdk);
  assert.deepEqual(input.config.pushActors, ['gr4vy-sdk-generate[bot]']);
  for (const login of ['speakeasy-github[bot]', 'github-actions[bot]']) {
    const { reasons } = evaluate({ ...input, run: { ...input.run, actor: { login } } });
    assert.ok(reasons[0].startsWith(`latest push was by ${login}`));
  }
  const { reasons } = evaluate({ ...input, pr: { ...input.pr, user: { login: 'github-actions[bot]' } } });
  assert.ok(reasons.includes('PR opened by github-actions[bot], not gr4vy-sdk-generate[bot]'));
});

test('typescript: a real App PR that adds a gen.yaml setting goes to a human for that alone', () => {
  assert.deepEqual(evaluate(load('typescript', 'typescript-new-gen-flag')), {
    ok: false,
    reasons: ['.speakeasy/gen.yaml: changes more than the version (2.4.38)'],
  });
});

test('a CI result for an older commit is not trusted', () => {
  const input = load('typescript');
  const { reasons } = evaluate({ ...input, run: { ...input.run, head_sha: 'deadbeef' } });
  assert.deepEqual(reasons, ['CI result is for an older commit than the PR head']);
});

test('fork PRs and other branches go to a human', () => {
  const input = load('python');
  const pr = { ...input.pr, head: { ...input.pr.head, ref: 'feature/x', repo: { full_name: 'evil/gr4vy-python' } } };
  const { reasons } = evaluate({ ...input, pr });
  assert.ok(reasons.includes('PR comes from a fork'));
  assert.ok(reasons.some((r) => r.startsWith('branch feature/x')));
});

test('workflow, test, hook and .genignore paths are blocked even inside src', () => {
  for (const [sdk, path] of [
    ['typescript', '.github/workflows/ci.yaml'],
    ['typescript', 'src/hooks/registration.ts'],
    ['typescript', 'src/lib/auth.ts'],
    ['typescript', 'src/lib/webhooks.ts'],
    ['python', 'tests/test_auth.py'],
    ['go', 'models/components/foo_test.go'],
    ['csharp', '.speakeasy/scripts/patch_update_models.py'],
    ['java', 'settings.gradle'],
    ['java-connectors', 'integration-tests/build.gradle'],
    ['java-connectors', 'build-extras.gradle'],
    ['java-connectors', 'src/main/java/org/openapis/openapi/hooks/SDKHooks.java'],
  ]) {
    const { reasons } = evaluate(withFile(load(sdk), { filename: path, status: 'modified', patch: '-a\n+b' }));
    assert.ok(reasons.includes(`${path}: blocked path`), `${sdk} ${path}`);
  }
});

test('a rename out of a blocked path is still blocked', () => {
  const { reasons } = evaluate(withFile(load('typescript'), {
    filename: 'src/models/hooks.ts', previous_filename: 'src/hooks/hooks.ts', status: 'renamed',
  }));
  assert.deepEqual(reasons, ['src/models/hooks.ts: blocked path']);
});

test('files outside the generated paths go to a human', () => {
  const { reasons } = evaluate(withFile(load('php'), { filename: 'Makefile', status: 'added', patch: '+x' }));
  assert.deepEqual(reasons, ['Makefile: not a generated path']);
});

test('a new dependency in a manifest goes to a human', () => {
  const patch = '@@ -1,3 +1,4 @@\n   "dependencies": {\n+    "left-pad": "2.4.37",\n     "zod": "^3.25.0"';
  const { reasons } = evaluate(withFile(load('typescript'), { filename: 'package.json', status: 'modified', patch }));
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /^package.json: changes more than the version/);
});

test('an install script in a manifest goes to a human', () => {
  const patch = '@@ -1,2 +1,2 @@\n-  "version": "2.4.36",\n+  "version": "2.4.37",\n+  "scripts": { "postinstall": "node x.js" },';
  assert.equal(isVersionBumpTo(patch, '2.4.37'), false);
});

test('a dependency bump goes to a human, the SDK version bump does not', () => {
  assert.equal(isVersionBumpTo('-  "version": "2.4.36",\n+  "version": "2.4.37",', '2.4.37'), true);
  assert.equal(isVersionBumpTo('-    "zod": "3.25.0"\n+    "zod": "3.25.1"', '2.4.37'), false);
  assert.equal(isVersionBumpTo('-version: 1\n', '2.4.37'), false);
  assert.equal(isVersionBumpTo('@@ -1 +1 @@\n context', '2.4.37'), false);
});

test('a truncated file list is not trusted', () => {
  const input = load('go');
  const { reasons } = evaluate({ ...input, pr: { ...input.pr, changed_files: 3001 } });
  assert.deepEqual(reasons, [`could only read ${input.files.length} of 3001 changed files`]);
});

test('glob semantics', () => {
  assert.ok(matchesAny('src/a/b.ts', ['src/**']));
  assert.ok(matchesAny('a_test.go', ['**/*_test.go']));
  assert.ok(matchesAny('x/y/a_test.go', ['**/*_test.go']));
  assert.ok(!matchesAny('internal/a.go', ['*.go']));
  assert.ok(!matchesAny('srcx/a.ts', ['src/**']));
});

const pkg = (over = {}) => JSON.stringify({
  name: '@gr4vy/sdk',
  version: '2.4.39',
  scripts: { build: 'tsc' },
  dependencies: { zod: '^4.6.6' },
  devDependencies: { vitest: '^4.1.11' },
  ...over,
});

test('a manifest may bump the version and existing dependency ranges', () => {
  const after = pkg({ version: '2.4.40', dependencies: { zod: '^3.25.0 || ^4.0.0' }, devDependencies: { vitest: '^4.1.12' } });
  assert.equal(checkManifest({ before: pkg(), after }, '2.4.40'), null);
});

test('a manifest that adds, removes or rewires anything goes to a human', () => {
  assert.equal(checkManifest({ before: pkg(), after: pkg({ dependencies: { zod: '^4.6.6', 'left-pad': '^1.0.0' } }) }, '2.4.40'), 'adds dependencies left-pad');
  assert.equal(checkManifest({ before: pkg(), after: pkg({ devDependencies: {} }) }, '2.4.40'), 'removes devDependencies vitest');
  assert.equal(checkManifest({ before: pkg(), after: pkg({ scripts: { build: 'tsc', postinstall: 'node x.js' } }) }, '2.4.40'), 'changes scripts');
  assert.equal(checkManifest({ before: pkg(), after: pkg({ version: '9.9.9' }) }, '2.4.40'), 'sets version 9.9.9, not 2.4.40');
  for (const zod of ['npm:evil@1.0.0', 'github:evil/zod', 'file:../zod', 'https://evil.example/zod.tgz', null, 42]) {
    assert.equal(checkManifest({ before: pkg(), after: pkg({ dependencies: { zod } }) }, '2.4.40'), 'points dependencies zod away from the npm registry');
  }
});

test('a malformed manifest, or a version change with nothing to check it against, goes to a human', () => {
  assert.equal(checkManifest({ before: pkg(), after: '{ not json' }, '2.4.40'), 'is not a JSON object');
  assert.equal(checkManifest({ before: pkg(), after: '[]' }, '2.4.40'), 'is not a JSON object');
  assert.equal(checkManifest({ before: pkg(), after: pkg({ dependencies: ['zod'] }) }, '2.4.40'), 'has a malformed dependencies');
  assert.equal(checkManifest({ before: pkg(), after: pkg({ version: null }) }, null), 'no new releaseVersion in .speakeasy/gen.lock to check the bump against');
});

test('typescript: a dependency bump in package.json merges when its contents are read', () => {
  const input = load('typescript');
  const before = pkg({ version: '2.4.36', dependencies: { zod: '^4.6.6' } });
  const after = pkg({ version: '2.4.37', dependencies: { zod: '^3.25.0 || ^4.0.0' } });
  assert.deepEqual(evaluate({ ...input, manifests: { 'package.json': { before, after } } }), { ok: true, reasons: [] });
});

test('a version-only file may only change its version line', () => {
  const bump = (from, to) => `@@ -1,3 +1,3 @@\n {\n-${from}\n+${to}\n }`;
  assert.equal(isVersionBumpTo(bump('  "version": "2.4.39",', '  "version": "2.4.40",'), '2.4.40'), true);
  assert.equal(isVersionBumpTo(bump('    "zod": "^4.6.6"', '    "zod": "^2.4.40"'), '2.4.40'), false);
  assert.equal(isVersionBumpTo(bump('  foo: 1.2.3', '  foo: 2.4.40'), '2.4.40'), false);
});

test('python: a regenerated poetry.lock merges unattended', () => {
  const input = withFile(load('python'), { filename: 'poetry.lock', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' });
  assert.deepEqual(evaluate(input), { ok: true, reasons: [] });
});

test('each SDK may bump an existing dependency to another registry version', () => {
  for (const [format, was, is] of [
    ['pyproject', '    "httpx >=0.28.1",', '    "httpx >=0.29.0",'],
    ['pyproject', '    "PyJWT (>=2.10.1,<3.0.0)",', '    "PyJWT (>=2.11.0,<3.0.0)",'],
    ['gradle', "    implementation 'com.auth0:java-jwt:4.5.0'", "    implementation 'com.auth0:java-jwt:4.6.0'"],
    ['gradle', "    id 'cl.franciscosolis.sonatype-central-upload' version '1.0.3'", "    id 'cl.franciscosolis.sonatype-central-upload' version '1.0.4'"],
    ['gomod', '\tgithub.com/google/uuid v1.6.0', '\tgithub.com/google/uuid v1.7.0'],
    ['gomod', 'go 1.26.8', 'go 1.26.9'],
    ['csproj', '    <PackageReference Include="nodatime" Version="3.1.9" />', '    <PackageReference Include="nodatime" Version="3.2.0" />'],
  ]) {
    assert.equal(isDependencyBump(was, is, format), true, `${format}: ${is}`);
  }
});

test('a dependency line that swaps the package, its source or anything else goes to a human', () => {
  for (const [format, was, is] of [
    ['pyproject', '    "httpx >=0.28.1",', '    "evil-httpx >=0.28.1",'],
    ['pyproject', '    "httpx >=0.28.1",', '    "httpx @ git+https://evil.example/httpx",'],
    ['pyproject', '    "httpx @ git+https://evil.example/httpx",', '    "httpx >=0.29.0",'],
    ['pyproject', 'build-backend = "poetry.core.masonry.api"', 'build-backend = "evil.backend"'],
    ['pyproject', 'requires-python = ">=3.10"', 'requires-python = ">=3.11"'],
    ['pyproject', 'pytest = "^9.0.3"', 'pytest = "^9.1.0"'],
    ['pyproject', '    "foo 1.0",', '    "foo 2.0",'],
    ['gomod', 'retract v1.6.0', 'retract v1.7.0'],
    ['pyproject', 'version = "2.4.27"', 'version = "9.9.9"'],
    ['gradle', "    implementation 'com.auth0:java-jwt:4.5.0'", "    implementation 'com.evil:java-jwt:4.5.0'"],
    ['gradle', "    implementation 'com.auth0:java-jwt:4.5.0'", "    implementation files('/tmp/evil.jar')"],
    ['gomod', '\tgithub.com/google/uuid v1.6.0', '\tgithub.com/evil/uuid v1.6.0'],
    ['gomod', '\tgithub.com/google/uuid v1.6.0', '\tgithub.com/google/uuid => ../uuid'],
    ['csproj', '    <PackageReference Include="nodatime" Version="3.1.9" />', '    <PackageReference Include="evil" Version="3.1.9" />'],
  ]) {
    assert.equal(isDependencyBump(was, is, format), false, `${format}: ${is}`);
  }
});

test('python: a pyproject.toml dependency bump merges, an added dependency does not', () => {
  const bump = '@@ -11,3 +11,3 @@\n     "httpcore >=1.0.9",\n-    "httpx >=0.28.1",\n+    "httpx >=0.29.0",\n     "jsonpath-python >=1.0.6",';
  const input = load('python');
  const files = input.files.map((f) => (f.filename === 'pyproject.toml' ? { ...f, patch: `${f.patch}\n${bump}` } : f));
  assert.deepEqual(evaluate({ ...input, files }), { ok: true, reasons: [] });
  const added = '@@ -11,2 +11,3 @@\n     "httpcore >=1.0.9",\n+    "left-pad >=1.0.0",\n     "httpx >=0.28.1",';
  const withAdd = input.files.map((f) => (f.filename === 'pyproject.toml' ? { ...f, patch: `${f.patch}\n${added}` } : f));
  assert.equal(evaluate({ ...input, files: withAdd }).ok, false);
});

test('php: composer.json dependency fields are require and require-dev', () => {
  const pkg = (require) => JSON.stringify({ name: 'gr4vy/gr4vy-php', require, 'require-dev': { 'phpunit/phpunit': '^11.5.50' } });
  assert.equal(checkManifest({ before: pkg({ 'guzzlehttp/guzzle': '^7.15.2' }), after: pkg({ 'guzzlehttp/guzzle': '^7.16.0' }) }, '1.7.35', ['require', 'require-dev']), null);
  assert.equal(checkManifest({ before: pkg({ 'guzzlehttp/guzzle': '^7.15.2' }), after: pkg({ 'guzzlehttp/guzzle': '^7.15.2', 'evil/pkg': '^1.0' }) }, '1.7.35', ['require', 'require-dev']), 'adds require evil/pkg');
  assert.equal(checkManifest({ before: pkg({ 'evil/pkg': 'git+https://evil.example/x' }), after: pkg({ 'evil/pkg': '^1.0' }) }, '1.7.35', ['require', 'require-dev']), 'points require evil/pkg away from the npm registry');
});

test('python: a gen.lock too large for GitHub to diff is checked against the release version read from the file', () => {
  const input = load('python');
  const files = input.files.map((f) => (f.filename === '.speakeasy/gen.lock' ? { ...f, patch: undefined } : f));
  assert.equal(evaluate({ ...input, files }).ok, false);
  assert.deepEqual(evaluate({ ...input, files, releaseVersion: '2.4.27' }), { ok: true, reasons: [] });
  assert.equal(evaluate({ ...input, files, releaseVersion: null }).ok, false);
});

test('cli: a real regen PR merges unattended', () => {
  assert.deepEqual(evaluate(load('cli')), { ok: true, reasons: [] });
});

test('cli: regenerated commands, docs, golden file and a Go version bump merge unattended', () => {
  let input = load('cli');
  for (const filename of ['internal/commands/generated/zz_generated_commands.go', 'internal/cli/testdata/command_tree.golden', 'docs/gr4vy_transactions_list.md']) {
    input = withFile(input, { filename, status: 'modified', patch: '-a\n+b' });
  }
  const goMod = input.files.find((f) => f.filename === 'go.mod');
  const files = input.files.map((f) => (f === goMod ? { ...f, patch: `@@ -1,3 +1,3 @@\n-go 1.26.8\n+go 1.26.10\n${goMod.patch}` } : f));
  assert.deepEqual(evaluate({ ...input, files }), { ok: true, reasons: [] });
});

test('cli: the generator, tests and release config go to a human', () => {
  for (const path of ['internal/commands/generated/zz_extra.go', 'internal/commands/generated/doc.go', 'internal/gen/emit.go', 'internal/cli/root.go', 'test/cli_e2e_test.go', 'internal/cli/tree_test.go', '.goreleaser.yaml', '.release-please-manifest.json', 'docs/README.md']) {
    const { ok } = evaluate(withFile(load('cli'), { filename: path, status: 'modified', patch: '-a\n+b' }));
    assert.equal(ok, false, path);
  }
});

test('cli: a new Go dependency goes to a human', () => {
  const input = load('cli');
  const files = input.files.map((f) => (f.filename === 'go.mod' ? { ...f, patch: '@@ -5,2 +5,3 @@\n require (\n+\tgithub.com/evil/pkg v1.0.0\n \tgithub.com/gr4vy/gr4vy-go v1.14.9' } : f));
  assert.match(evaluate({ ...input, files }).reasons[0], /^go.mod: changes more than versions/);
});

function loadRelease({ before = '{\n  ".": "1.48.0"\n}\n', after = '{\n  ".": "1.49.0"\n}\n' } = {}) {
  return { ...load('cli', 'cli-release'), manifest: { before, after } };
}

test('cli: a release PR that only bumps the version and adds to the changelog merges unattended', () => {
  assert.deepEqual(evaluateRelease(loadRelease()), { ok: true, reasons: [] });
});

test('cli: a release PR may only bump the version and add changelog entries', () => {
  const cases = [
    [{ after: '{\n  ".": "1.48.0",\n  "x": "1"\n}\n' }, '.release-please-manifest.json: changes x, not the "." version'],
    [{ before: '{\n  ".": "1.48.0",\n  "other": "1.0.0"\n}\n', after: '{\n  ".": "1.48.0",\n  "other": "1.1.0"\n}\n' }, '.release-please-manifest.json: changes other, not the "." version'],
    [{ after: '{\n  ".": "1.47.0"\n}\n' }, '.release-please-manifest.json: 1.48.0 to 1.47.0 is not a version bump'],
    [{ after: '{\n  ".": "1.49.0-beta"\n}\n' }, '.release-please-manifest.json: 1.48.0 to 1.49.0-beta is not a version bump'],
  ];
  for (const [opts, reason] of cases) assert.deepEqual(evaluateRelease(loadRelease(opts)).reasons, [reason]);

  const input = loadRelease();
  const files = input.files.map((f) => (f.filename === 'CHANGELOG.md' ? { ...f, patch: `${f.patch}\n-## old entry` } : f));
  assert.deepEqual(evaluateRelease({ ...input, files }).reasons, ['CHANGELOG.md: changes existing entries']);

  const noChangelog = { ...input, pr: { ...input.pr, changed_files: 1 }, files: input.files.filter((f) => f.filename !== 'CHANGELOG.md') };
  assert.deepEqual(evaluateRelease(noChangelog).reasons, ['CHANGELOG.md is unchanged']);

  const extra = withFile(input, { filename: 'go.mod', status: 'modified', patch: '-a\n+b' });
  assert.deepEqual(evaluateRelease(extra).reasons, ['go.mod: not a release file']);
});

test('cli: a release PR from anyone but the generate App goes to a human', () => {
  const input = loadRelease();
  const mallory = { login: 'mallory' };
  const commits = input.commits.map((c) => ({ ...c, author: mallory, committer: mallory }));
  assert.match(evaluateRelease({ ...input, commits }).reasons[0], /^commit \w+ by mallory$/);
  const pr = { ...input.pr, user: mallory };
  assert.ok(evaluateRelease({ ...input, pr }).reasons.includes('PR opened by mallory, not gr4vy-sdk-generate[bot]'));
  const run = { ...input.run, actor: mallory };
  assert.match(evaluateRelease({ ...input, run }).reasons[0], /^latest push was by mallory/);
});

test('cli: a release PR commit made through the API (committer web-flow, signed by GitHub) merges', () => {
  const input = loadRelease();
  const viaApi = (verified, author = 'gr4vy-sdk-generate[bot]') => input.commits.map((c) => ({
    ...c, author: { login: author }, committer: { login: 'web-flow' }, commit: { verification: { verified } },
  }));
  assert.deepEqual(evaluateRelease({ ...input, commits: viaApi(true) }), { ok: true, reasons: [] });
  assert.match(evaluateRelease({ ...input, commits: viaApi(false) }).reasons[0], /^commit \w+ by web-flow$/);
  assert.match(evaluateRelease({ ...input, commits: viaApi(true, 'mallory') }).reasons[0], /^commit \w+ by mallory$/);
});

test('web-flow commits never pass a regen PR', () => {
  const input = load('cli');
  const commits = input.commits.map((c) => ({ ...c, committer: { login: 'web-flow' }, commit: { verification: { verified: true } } }));
  assert.match(evaluate({ ...input, commits }).reasons[0], /^commit \w+ by web-flow$/);
});

test('a dependency downgrade in a pinned dependency file goes to a human', () => {
  for (const [format, was, is] of [
    ['pyproject', '    "httpx >=0.29.0",', '    "httpx >=0.28.1",'],
    ['gradle', "    implementation 'com.auth0:java-jwt:4.6.0'", "    implementation 'com.auth0:java-jwt:4.5.0'"],
    ['gomod', '\tgithub.com/google/uuid v1.7.0', '\tgithub.com/google/uuid v1.6.0'],
    ['gomod', 'go 1.26.10', 'go 1.26.8'],
    ['csproj', '    <PackageReference Include="nodatime" Version="3.2.0" />', '    <PackageReference Include="nodatime" Version="3.1.9" />'],
    ['gomod', '\tgithub.com/google/uuid v1.7.0-rc.2', '\tgithub.com/google/uuid v1.7.0-rc.1'],
    ['pyproject', '    "httpx >=0.28.1",', '    "httpx <0.29.0",'],
  ]) {
    assert.equal(isDependencyBump(was, is, format), false, `${format}: ${is}`);
  }
});

test('version comparison', () => {
  assert.equal(isDowngrade('1.10.0', '1.9.0'), true);
  assert.equal(isDowngrade('1.9.0', '1.10.0'), false);
  assert.equal(isDowngrade('v1.2.3', 'v1.2.3'), false);
  assert.equal(isDowngrade('^3.25.0', '^3.25.0 || ^4.0.0'), false);
  assert.equal(isDowngrade('>=2.10.1,<3.0.0', '>=2.9.0,<3.0.0'), true);
  assert.equal(isDowngrade('1.2', '1.2.0'), false);
  assert.equal(isDowngrade('latest', '1.0.0'), false);
  assert.equal(isDowngrade('1.2.3-rc.2', '1.2.3-rc.1'), true);
  assert.equal(isDowngrade('1.2.3-rc.9', '1.2.3-rc.10'), false);
  assert.equal(isDowngrade('1.2.3', '1.2.3-rc.1'), true);
  assert.equal(isDowngrade('1.2.3-rc.1', '1.2.3'), true, 'a suffix that cannot be ordered goes to a human');
  assert.equal(isDowngrade('>=0.28.1.post1', '>=0.28.1'), true);
  assert.equal(isDowngrade('>=2.10.1,<3.0.0', '>=2.10.1,<2.0.0'), true);
  assert.equal(isDowngrade('>=2.10.1,<3.0.0', '>=2.11.0,<3.0.0'), false);
  assert.equal(isDowngrade('>=2.0.0rc2', '>=2.0.0rc1'), true);
  assert.equal(isDowngrade('v0.0.0-20240101120000-abcdef123456', 'v0.0.0-20230101120000-fedcba654321'), true);
});
