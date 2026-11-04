import { matchesAny } from './glob.mjs';

const VERSION = /\d+(?:\.\d+)+(?:-[0-9A-Za-z.-]+)?/g;
const VERSION_LINE = /^\s*(?:"version"\s*:|version\s*[:=]|<Version>)/i;

export function evaluate({ pr, run, commits, files, config, genignore = [], manifests = {}, releaseVersion = findReleaseVersion(files) }) {
  const reasons = checkSource({ pr, run, commits, config, branchPrefix: config.branchPrefix });
  const fail = (msg) => reasons.push(msg);

  if (files.length !== pr.changed_files) fail(`could only read ${files.length} of ${pr.changed_files} changed files`);
  const blocked = [...config.blocked, ...genignore];
  for (const f of files) {
    const paths = f.previous_filename ? [f.previous_filename, f.filename] : [f.filename];
    const reason = checkFile(f, paths, { config, blocked, releaseVersion, manifests });
    if (reason) fail(`${f.filename}: ${reason}`);
  }

  return { ok: reasons.length === 0, reasons };
}

export function evaluateRelease({ pr, run, commits, files, config, manifest }) {
  const release = config.releasePr;
  const reasons = checkSource({ pr, run, commits, config, branchPrefix: release.branchPrefix, signedCommitters: release.signedCommitters ?? [] });
  const fail = (msg) => reasons.push(msg);

  if (files.length !== pr.changed_files) fail(`could only read ${files.length} of ${pr.changed_files} changed files`);
  for (const f of files) {
    let reason;
    if (f.previous_filename) reason = 'renamed';
    else if (f.filename === release.manifest) reason = checkReleaseManifest(f, manifest);
    else if (f.filename === release.changelog) reason = checkChangelog(f);
    else reason = 'not a release file';
    if (reason) fail(`${f.filename}: ${reason}`);
  }
  if (!files.some((f) => f.filename === release.manifest)) fail(`${release.manifest} is unchanged`);
  if (!files.some((f) => f.filename === release.changelog)) fail(`${release.changelog} is unchanged`);

  return { ok: reasons.length === 0, reasons };
}

function checkSource({ pr, run, commits, config, branchPrefix, signedCommitters = [] }) {
  const reasons = [];
  const fail = (msg) => reasons.push(msg);

  if (pr.state !== 'open') fail(`PR is ${pr.state}`);
  if (pr.draft) fail('PR is a draft');
  if (pr.head.repo?.full_name !== pr.base.repo.full_name) fail('PR comes from a fork');
  if (pr.base.ref !== config.baseBranch) fail(`PR targets ${pr.base.ref}, not ${config.baseBranch}`);
  if (pr.user.login !== config.prAuthor) fail(`PR opened by ${pr.user.login}, not ${config.prAuthor}`);
  if (!pr.head.ref.startsWith(branchPrefix)) fail(`branch ${pr.head.ref} is not a ${branchPrefix}* branch`);

  if (run.head_sha !== pr.head.sha) fail('CI result is for an older commit than the PR head');
  if (run.event !== 'pull_request') fail(`CI ran on ${run.event}, not pull_request`);
  if (run.conclusion !== 'success') fail(`CI concluded ${run.conclusion}`);
  if (!config.pushActors.includes(run.actor?.login)) {
    fail(`latest push was by ${run.actor?.login ?? 'unknown'}, not ${config.pushActors.join(' or ')}`);
  }

  if (commits.length !== pr.commits) fail(`could only read ${commits.length} of ${pr.commits} commits`);
  for (const c of commits) {
    const signedByGitHub = signedCommitters.includes(c.committer?.login) && c.commit?.verification?.verified === true;
    for (const who of signedByGitHub ? [c.author?.login] : [c.author?.login, c.committer?.login]) {
      if (!config.commitAuthors.includes(who)) {
        fail(`commit ${c.sha.slice(0, 7)} by ${who ?? 'an unknown account'}`);
        break;
      }
    }
  }
  return reasons;
}

function checkReleaseManifest(f, manifest) {
  if (f.status !== 'modified') return `${f.status}, only a version bump is allowed`;
  const before = manifest && parseObject(manifest.before);
  const after = manifest && parseObject(manifest.after);
  if (!before || !after) return 'could not read it as a JSON object';
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const changed = keys.filter((k) => before[k] !== after[k]);
  if (changed.length !== 1 || changed[0] !== '.' || !('.' in before) || !('.' in after)) return `changes ${changed.join(', ') || 'nothing'}, not the "." version`;
  return isNewerVersion(before[changed[0]], after[changed[0]]) ? null : `${before[changed[0]]} to ${after[changed[0]]} is not a version bump`;
}

function checkChangelog(f) {
  if (f.status !== 'modified' && f.status !== 'added') return `${f.status}, only new entries are allowed`;
  if (f.patch == null) return 'diff too large to check';
  return f.patch.split('\n').some((line) => line.startsWith('-')) ? 'changes existing entries' : null;
}

const RELEASE = /^(\d+)\.(\d+)\.(\d+)$/;

function isNewerVersion(was, is) {
  const a = typeof was === 'string' && was.match(RELEASE);
  const b = typeof is === 'string' && is.match(RELEASE);
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i++) {
    if (Number(b[i]) !== Number(a[i])) return Number(b[i]) > Number(a[i]);
  }
  return false;
}

function checkFile(f, paths, { config, blocked, releaseVersion, manifests }) {
  if (paths.some((p) => matchesAny(p, blocked))) return 'blocked path';
  const manifest = config.manifests?.includes(f.filename);
  if (manifest && manifests[f.filename]) {
    if (f.status !== 'modified') return `${f.status}, only dependency and version bumps are allowed`;
    return checkManifest(manifests[f.filename], releaseVersion, config.manifestDependencyFields);
  }
  const dependencies = config.dependencyFiles?.find((d) => d.path === f.filename);
  if (dependencies) {
    if (f.status !== 'modified') return `${f.status}, only dependency and version bumps are allowed`;
    if (f.patch == null) return 'diff too large to check';
    return isBumpPatch(f.patch, releaseVersion, (was, is) => isDependencyBump(was, is, dependencies.format))
      ? null
      : `changes more than versions${releaseVersion ? ` (${releaseVersion}) and existing dependency versions` : ''}`;
  }
  if (manifest || paths.some((p) => matchesAny(p, config.versionOnly))) {
    if (f.status !== 'modified') return `${f.status}, only version bumps are allowed`;
    if (!releaseVersion) return 'no new releaseVersion in .speakeasy/gen.lock to check the bump against';
    if (f.patch == null) return 'diff too large to check';
    return isVersionBumpTo(f.patch, releaseVersion) ? null : `changes more than the version (${releaseVersion})`;
  }
  if (paths.every((p) => matchesAny(p, config.allowed))) return null;
  return 'not a generated path';
}

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

export function checkManifest({ before, after }, releaseVersion, dependencyFields = DEPENDENCY_FIELDS) {
  const old = parseObject(before);
  const now = parseObject(after);
  if (!old || !now) return 'is not a JSON object';
  for (const field of new Set([...Object.keys(old), ...Object.keys(now)])) {
    if (field === 'version') {
      if (old.version === now.version) continue;
      if (!releaseVersion) return 'no new releaseVersion in .speakeasy/gen.lock to check the bump against';
      if (now.version !== releaseVersion) return `sets version ${now.version}, not ${releaseVersion}`;
    } else if (dependencyFields.includes(field)) {
      if (![old[field], now[field]].every((deps) => deps === undefined || isObject(deps))) return `has a malformed ${field}`;
      const was = Object.keys(old[field] ?? {});
      const is = Object.keys(now[field] ?? {});
      const added = is.filter((name) => !was.includes(name));
      const removed = was.filter((name) => !is.includes(name));
      if (added.length) return `adds ${field} ${added.join(', ')}`;
      if (removed.length) return `removes ${field} ${removed.join(', ')}`;
      const elsewhere = is.filter((name) => now[field][name] !== old[field][name] && ![old[field][name], now[field][name]].every(isRegistryRange));
      if (elsewhere.length) return `points ${field} ${elsewhere.join(', ')} away from the npm registry`;
    } else if (JSON.stringify(old[field]) !== JSON.stringify(now[field])) {
      return `changes ${field}`;
    }
  }
  return null;
}

function parseObject(text) {
  try {
    const value = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function isRegistryRange(value) {
  return typeof value === 'string' && !/[:/]/.test(value);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function findReleaseVersion(files) {
  const lock = files.find((f) => f.filename === '.speakeasy/gen.lock');
  return lock?.patch?.match(/^\+\s*releaseVersion:\s*(\S+)\s*$/m)?.[1] ?? null;
}

export function releaseVersionIn(genLock) {
  return genLock.match(/^\s*releaseVersion:\s*(\S+)\s*$/m)?.[1] ?? null;
}

export function isVersionBumpTo(patch, releaseVersion) {
  return isBumpPatch(patch, releaseVersion, () => false);
}

const DEPENDENCY_LINES = {
  pyproject: [
    /^(\s*")([A-Za-z0-9][\w.-]*(?:\[[^\]]+\])?)(\s*\(?)([<>=!~][^")]*?)(\)?",?\s*)$/,
  ],
  gradle: [
    /^(\s*(?:api|implementation|testImplementation|compileOnly|runtimeOnly|testRuntimeOnly|annotationProcessor)\s*\(?\s*['"])([^:'"\s]+:[^:'"\s]+)(:)([^'"]+)(['"]\s*\)?\s*)$/,
    /^(\s*id\s*\(?\s*['"])([^'"]+)(['"]\s*\)?\s+version\s+['"])([^'"]+)(['"]\s*)$/,
  ],
  gomod: [
    /^(\s*(?:require\s+)?)([a-z0-9][\w.~-]*\/[\w.~/-]*)(\s+)(v\d\S*)(\s*(?:\/\/\s*indirect)?\s*)$/,
    /^(\s*)(go|toolchain)(\s+)(\S+)(\s*)$/,
  ],
  csproj: [
    /^(\s*<PackageReference\s+Include=")([^"]+)("\s+Version=")([^"]+)("\s*\/>\s*)$/,
  ],
};
const REGISTRY_VERSION = /^(?=.*\d)[\s<>=!~^*|,.\w+-]+$/;
const operators = (version) => version.replace(/v?\d+(?:\.\d+)*(?:[-.]?[0-9A-Za-z]+)*(?:\+[0-9A-Za-z.-]+)?/g, '');

export function isDependencyBump(was, is, format) {
  return (DEPENDENCY_LINES[format] ?? []).some((pattern) => {
    const before = was.match(pattern);
    const after = is.match(pattern);
    if (!before || !after || after[2] === 'version') return false;
    return [1, 2, 3, 5].every((i) => before[i] === after[i]) && REGISTRY_VERSION.test(before[4]) && REGISTRY_VERSION.test(after[4])
      && operators(before[4]) === operators(after[4]) && !isDowngrade(before[4], after[4]);
  });
}

export function isDowngrade(was, is) {
  const versions = (v) => [...String(v ?? '').matchAll(/(\d+(?:\.\d+)*)([0-9A-Za-z.-]*)/g)];
  const suffix = (m) => m[2].match(/\d+|[A-Za-z]+/g) ?? [];
  const before = versions(was);
  const after = versions(is);
  if (after.length < before.length) return true;
  return before.some((a, i) => after[i]
    && (compareParts(a[1].split('.'), after[i][1].split('.'), '0') || compareParts(suffix(a), suffix(after[i]))) > 0);
}

function compareParts(a, b, pad) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? pad;
    const y = b[i] ?? pad;
    if (x?.toLowerCase() === y?.toLowerCase()) continue;
    if (!/^\d+$/.test(x) || !/^\d+$/.test(y)) return 1;
    if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
  }
  return 0;
}

function isVersionLineBump(was, is, releaseVersion) {
  if (!releaseVersion || !VERSION_LINE.test(is)) return false;
  if (was.replace(VERSION, '<v>') !== is.replace(VERSION, '<v>')) return false;
  const versions = is.match(VERSION) ?? [];
  return versions.length > 0 && versions.every((v) => v === releaseVersion);
}

function isBumpPatch(patch, releaseVersion, otherwiseAllowed) {
  const removed = [];
  const added = [];
  let pairs = 0;
  const flush = () => {
    if (removed.length !== added.length) return false;
    for (let i = 0; i < removed.length; i++) {
      if (!isVersionLineBump(removed[i], added[i], releaseVersion) && !otherwiseAllowed(removed[i], added[i])) return false;
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
