import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../guard/gate.mjs';

const REPO = 'gr4vy/gr4vy-typescript';
const BOT = 'gr4vy-sdk-release[bot]';
const HEAD = 'c'.repeat(40);

function fakeGitHub({ main = HEAD, version = '2.4.38', tagged = false, latest = 'v2.4.37', status = 'ahead', commits = [{ sha: HEAD, pr: 371, mergedBy: BOT }] } = {}) {
  const routes = {
    [`/repos/${REPO}/commits/main`]: { sha: main },
    [`/repos/${REPO}/contents/.speakeasy/gen.lock?ref=${HEAD}`]: { content: Buffer.from(`management:\n  releaseVersion: ${version}\n`).toString('base64') },
    [`/repos/${REPO}/compare/${latest}...${HEAD}`]: { status, total_commits: commits.length, commits: commits.map(({ sha }) => ({ sha })) },
  };
  if (tagged) routes[`/repos/${REPO}/git/ref/tags/v${version}`] = {};
  if (latest) routes[`/repos/${REPO}/releases/latest`] = { tag_name: latest };
  for (const c of commits) {
    routes[`/repos/${REPO}/commits/${c.sha}/pulls`] = c.pr ? [{ number: c.pr, merge_commit_sha: c.sha }] : [];
    if (c.pr) routes[`/repos/${REPO}/pulls/${c.pr}`] = { number: c.pr, merged_by: { login: c.mergedBy } };
  }
  return {
    get: async (path) => {
      if (path in routes) return routes[path];
      throw Object.assign(new Error(`404 ${path}`), { status: 404 });
    },
  };
}

const run = (opts) => decide(fakeGitHub(opts), { repo: REPO, headSha: HEAD, bot: BOT });

test('a version made only of bot merges publishes unattended', async () => {
  assert.deepEqual(await run(), { publish: true, version: '2.4.38', mode: 'auto', why: `every change since the last release was merged by ${BOT}` });
});

test('a human merge since the last release needs approval', async () => {
  const commits = [{ sha: 'a'.repeat(40), pr: 370, mergedBy: 'cbetta' }, { sha: HEAD, pr: 371, mergedBy: BOT }];
  assert.deepEqual(await run({ commits }), { publish: true, version: '2.4.38', mode: 'manual', why: '#370 was merged by cbetta' });
});

test('a direct push to main needs approval', async () => {
  const { mode, why } = await run({ commits: [{ sha: HEAD }] });
  assert.equal(mode, 'manual');
  assert.equal(why, `${HEAD.slice(0, 7)} was pushed to main without a PR`);
});

test('no previous release, or history that diverged from it, needs approval', async () => {
  assert.equal((await run({ latest: null })).mode, 'manual');
  assert.equal((await run({ status: 'diverged' })).mode, 'manual');
});

test('an already released version does not publish again', async () => {
  assert.equal((await run({ tagged: true })).publish, false);
});

test('a commit main has moved past does not publish', async () => {
  assert.equal((await run({ main: 'd'.repeat(40) })).publish, false);
});
