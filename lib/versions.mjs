/** Semantic versions the way the release train uses them: plain `X.Y.Z`, tagged `vX.Y.Z`. */

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/;

export const RC_PREFIX = 'release-candidate/';

/** Returns `{ major, minor, patch }`, or `null` when the string is not a version. */
export function parseVersion(value) {
  if (value && typeof value === 'object') return value;
  const match = VERSION.exec(String(value ?? '').trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function formatVersion(version) {
  const { major, minor, patch } = parseVersion(version);
  return `${major}.${minor}.${patch}`;
}

/** Negative when `a` sorts before `b`. */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

/** The highest of the given versions as a string, or `null` when none parses. */
export function maxVersion(values) {
  const versions = values.map(parseVersion).filter(Boolean).sort(compareVersions);
  return versions.length ? formatVersion(versions.at(-1)) : null;
}

export function rcBranch(version) {
  return `${RC_PREFIX}${formatVersion(version)}`;
}

/** `release-candidate/6.14.0` -> `"6.14.0"`; anything else -> `null`. */
export function versionFromRcBranch(branchName) {
  if (!String(branchName ?? '').startsWith(RC_PREFIX)) return null;
  const version = parseVersion(branchName.slice(RC_PREFIX.length));
  return version ? formatVersion(version) : null;
}
