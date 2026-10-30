// Decides whether a green main commit should publish, and whether it can do so
// without a human. Env: GITHUB_TOKEN, GITHUB_REPOSITORY, HEAD_SHA, BOT_LOGIN,
// GITHUB_OUTPUT.
import { appendFileSync } from 'node:fs';
import { client } from './github.mjs';

const repo = process.env.GITHUB_REPOSITORY;
const headSha = process.env.HEAD_SHA;
const bot = process.env.BOT_LOGIN;
const gh = client(process.env.GITHUB_TOKEN);

const decision = await decide();
console.log(`publish=${decision.publish} mode=${decision.mode ?? '-'}: ${decision.why}`);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `publish=${decision.publish}\nmode=${decision.mode ?? ''}\nversion=${decision.version ?? ''}\n`);
}

async function decide() {
  const main = await gh.get(`/repos/${repo}/commits/main`);
  if (main.sha !== headSha) return { publish: false, why: `main has moved on to ${main.sha.slice(0, 7)}; its own run decides` };

  const lock = await gh.get(`/repos/${repo}/contents/.speakeasy/gen.lock?ref=${headSha}`);
  const version = Buffer.from(lock.content, 'base64').toString('utf8').match(/^\s*releaseVersion:\s*(\S+)\s*$/m)?.[1];
  if (!version) return { publish: false, why: 'no releaseVersion in .speakeasy/gen.lock' };
  if (await exists(`/repos/${repo}/git/ref/tags/v${version}`)) return { publish: false, version, why: `v${version} is already released` };

  const unattended = await allBotMerged();
  return {
    publish: true,
    version,
    mode: unattended.ok ? 'auto' : 'manual',
    why: unattended.ok ? `every change since the last release was merged by ${bot}` : unattended.why,
  };
}

async function allBotMerged() {
  let latest;
  try {
    latest = await gh.get(`/repos/${repo}/releases/latest`);
  } catch (err) {
    if (err.status === 404) return { ok: false, why: 'no previous release to compare against' };
    throw err;
  }
  const compare = await gh.get(`/repos/${repo}/compare/${latest.tag_name}...${headSha}`);
  if (compare.status !== 'ahead') return { ok: false, why: `main is ${compare.status} of ${latest.tag_name}` };
  if (compare.total_commits !== compare.commits.length) return { ok: false, why: 'too many commits since the last release to check' };

  for (const c of compare.commits) {
    const prs = await gh.get(`/repos/${repo}/commits/${c.sha}/pulls`);
    const merged = prs.find((p) => p.merge_commit_sha === c.sha);
    if (!merged) return { ok: false, why: `${c.sha.slice(0, 7)} was pushed to main without a PR` };
    const pr = await gh.get(`/repos/${repo}/pulls/${merged.number}`);
    if (pr.merged_by?.login !== bot) return { ok: false, why: `#${pr.number} was merged by ${pr.merged_by?.login ?? 'unknown'}` };
  }
  return { ok: true };
}

async function exists(path) {
  try {
    await gh.get(path);
    return true;
  } catch (err) {
    if (err.status === 404) return false;
    throw err;
  }
}
