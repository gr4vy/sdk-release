import { matchesAny } from './glob.mjs';

const VERSION = /\d+(?:\.\d+)+(?:-[0-9A-Za-z.-]+)?/g;

export function evaluate({ pr, run, commits, files, config, genignore = [] }) {
  const reasons = [];
  const fail = (msg) => reasons.push(msg);

  if (pr.state !== 'open') fail(`PR is ${pr.state}`);
  if (pr.draft) fail('PR is a draft');
  if (pr.head.repo?.full_name !== pr.base.repo.full_name) fail('PR comes from a fork');
  if (pr.base.ref !== config.baseBranch) fail(`PR targets ${pr.base.ref}, not ${config.baseBranch}`);
  if (pr.user.login !== config.prAuthor) fail(`PR opened by ${pr.user.login}, not ${config.prAuthor}`);
  if (!pr.head.ref.startsWith(config.branchPrefix)) fail(`branch ${pr.head.ref} is not a ${config.branchPrefix}* branch`);

  if (run.head_sha !== pr.head.sha) fail('CI result is for an older commit than the PR head');
  if (run.event !== 'pull_request') fail(`CI ran on ${run.event}, not pull_request`);
  if (run.conclusion !== 'success') fail(`CI concluded ${run.conclusion}`);
  if (!config.pushActors.includes(run.actor?.login)) {
    fail(`latest push was by ${run.actor?.login ?? 'unknown'}, not ${config.pushActors.join(' or ')}`);
  }

  if (commits.length !== pr.commits) fail(`could only read ${commits.length} of ${pr.commits} commits`);
  for (const c of commits) {
    for (const who of [c.author?.login, c.committer?.login]) {
      if (!config.commitAuthors.includes(who)) {
        fail(`commit ${c.sha.slice(0, 7)} by ${who ?? 'an unknown account'}`);
        break;
      }
    }
  }

  if (files.length !== pr.changed_files) fail(`could only read ${files.length} of ${pr.changed_files} changed files`);
  const releaseVersion = findReleaseVersion(files);
  const blocked = [...config.blocked, ...genignore];
  for (const f of files) {
    const paths = f.previous_filename ? [f.previous_filename, f.filename] : [f.filename];
    const reason = checkFile(f, paths, { config, blocked, releaseVersion });
    if (reason) fail(`${f.filename}: ${reason}`);
  }

  return { ok: reasons.length === 0, reasons };
}

function checkFile(f, paths, { config, blocked, releaseVersion }) {
  if (paths.some((p) => matchesAny(p, blocked))) return 'blocked path';
  if (paths.some((p) => matchesAny(p, config.versionOnly))) {
    if (f.status !== 'modified') return `${f.status}, only version bumps are allowed`;
    if (!releaseVersion) return 'no new releaseVersion in .speakeasy/gen.lock to check the bump against';
    if (f.patch == null) return 'diff too large to check';
    return isVersionBumpTo(f.patch, releaseVersion) ? null : `changes more than the version (${releaseVersion})`;
  }
  if (paths.every((p) => matchesAny(p, config.allowed))) return null;
  return 'not a generated path';
}

function findReleaseVersion(files) {
  const lock = files.find((f) => f.filename === '.speakeasy/gen.lock');
  return lock?.patch?.match(/^\+\s*releaseVersion:\s*(\S+)\s*$/m)?.[1] ?? null;
}

export function isVersionBumpTo(patch, releaseVersion) {
  const removed = [];
  const added = [];
  let pairs = 0;
  const flush = () => {
    if (removed.length !== added.length) return false;
    for (let i = 0; i < removed.length; i++) {
      if (removed[i].replace(VERSION, '<v>') !== added[i].replace(VERSION, '<v>')) return false;
      const versions = added[i].match(VERSION) ?? [];
      if (versions.length === 0 || versions.some((v) => v !== releaseVersion)) return false;
      pairs++;
    }
    removed.length = 0;
    added.length = 0;
    return true;
  };

  for (const line of patch.split('\n')) {
    if (line.startsWith('-')) {
      if (added.length && !flush()) return false;
      removed.push(line.slice(1));
    } else if (line.startsWith('+')) {
      added.push(line.slice(1));
    } else if (!line.startsWith('\\')) {
      if (!flush()) return false;
    }
  }
  return flush() && pairs > 0;
}
