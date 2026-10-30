import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluate, isVersionBumpTo } from '../guard/guard.mjs';
import { matchesAny } from '../guard/glob.mjs';

const SDKS = ['typescript', 'python', 'java', 'go', 'php', 'csharp'];

// Fixtures are real merged Speakeasy PRs, reopened for the test.
function load(sdk) {
  const fx = JSON.parse(readFileSync(new URL(`fixtures/${sdk}.json`, import.meta.url)));
  const config = JSON.parse(readFileSync(new URL(`../config/${sdk}.json`, import.meta.url)));
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

test('a push by anyone but Speakeasy goes to a human', () => {
  const input = load('typescript');
  const { ok, reasons } = evaluate({ ...input, run: { ...input.run, actor: { login: 'mallory' } } });
  assert.equal(ok, false);
  assert.match(reasons[0], /latest push was by mallory/);
});

test('typescript: only gr4vy-sdk-generate may open and push a Speakeasy PR', () => {
  const input = load('typescript');
  assert.deepEqual(input.config.pushActors, ['gr4vy-sdk-generate[bot]']);
  for (const login of ['speakeasy-github[bot]', 'github-actions[bot]']) {
    const { reasons } = evaluate({ ...input, run: { ...input.run, actor: { login } } });
    assert.ok(reasons[0].startsWith(`latest push was by ${login}`));
  }
  const { reasons } = evaluate({ ...input, pr: { ...input.pr, user: { login: 'github-actions[bot]' } } });
  assert.deepEqual(reasons, ['PR opened by github-actions[bot], not gr4vy-sdk-generate[bot]']);
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
    ['java', 'build.gradle'],
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
