const VERSION_SOURCES = {
  speakeasy: {
    file: '.speakeasy/gen.lock',
    read: (text) => text.match(/^\s*releaseVersion:\s*(\S+)\s*$/m)?.[1],
    missing: 'no releaseVersion in .speakeasy/gen.lock',
    valid: /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
  },
  'release-please': {
    file: '.release-please-manifest.json',
    read: (text) => {
      try {
        return JSON.parse(text)['.'];
      } catch {
        return undefined;
      }
    },
    missing: 'no "." version in .release-please-manifest.json',
    valid: /^\d+\.\d+\.\d+$/,
  },
};

export async function decide(gh, { repo, headSha, bot, versionSource = 'speakeasy' }) {
  const source = VERSION_SOURCES[versionSource];
  if (!source) throw new Error(`unknown version source ${versionSource}`);
  const main = await gh.get(`/repos/${repo}/commits/main`);
  if (main.sha !== headSha) return { publish: false, why: `main has moved on to ${main.sha.slice(0, 7)}; its own run decides` };

  const file = await gh.get(`/repos/${repo}/contents/${source.file}?ref=${headSha}`);
  const version = source.read(Buffer.from(file.content, 'base64').toString('utf8'));
  if (!version) return { publish: false, why: source.missing };
  if (!source.valid.test(version)) return { publish: false, why: `${JSON.stringify(version)} is not a version` };
  if (await exists(gh, `/repos/${repo}/git/ref/tags/v${version}`)) return { publish: false, version, why: `v${version} is already released` };

  const unattended = await allBotMerged(gh, { repo, headSha, bot });
  return {
    publish: true,
    version,
    mode: unattended.ok ? 'auto' : 'manual',
    why: unattended.ok ? `every change since the last release was merged by ${bot} or came from Dependabot` : unattended.why,
  };
}

export async function allBotMerged(gh, { repo, headSha, bot }) {
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
    if (pr.merged_by?.login !== bot && !fromDependabot(pr, repo)) return { ok: false, why: `#${pr.number} was merged by ${pr.merged_by?.login ?? 'unknown'}` };
  }
  return { ok: true };
}

function fromDependabot(pr, repo) {
  return pr.user?.login === 'dependabot[bot]' && pr.head?.ref?.startsWith('dependabot/') && pr.head?.repo?.full_name === repo;
}

async function exists(gh, path) {
  try {
    await gh.get(path);
    return true;
  } catch (err) {
    if (err.status === 404) return false;
    throw err;
  }
}
