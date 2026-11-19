/**
 * Release state of a product, read the way release-sync-train reads it: versions come from the
 * branches, tags and merge requests GitLab holds, never from configuration. Pure functions.
 */

import { compareVersions, maxVersion, versionFromRcBranch } from './versions.mjs';

/**
 * The highest version a repository has shipped. Tags are the official record, but a candidate
 * merged into the default branch is released in practice before its tag exists.
 *
 * @param {{ tags?: {name: string, at?: string}[], mergedRc?: {version: string, at?: string}[] }} input
 */
export function repoReleased({ tags = [], mergedRc = [] }) {
  const candidates = [
    ...tags.map((tag) => ({ version: maxVersion([tag.name]), source: 'tag', at: tag.at ?? null })),
    ...mergedRc.map((rc) => ({ version: maxVersion([rc.version]), source: 'merge', at: rc.at ?? null })),
  ].filter((candidate) => candidate.version);

  if (candidates.length === 0) return null;
  // On a tie the tag wins: it is the stronger evidence for the same version.
  candidates.sort((a, b) => compareVersions(a.version, b.version) || (a.source === 'tag' ? 1 : -1));
  return candidates.at(-1);
}

/**
 * Splits a repository's `release-candidate/*` branches into open candidates and leftovers.
 * A branch is a leftover when its version is not above the product's highest tag (the train's
 * rule), or when this repository already merged that candidate into its default branch.
 *
 * @param {{name: string}[]} branches
 * @param {{ productTagVersion?: string|null, mergedRcVersions?: string[] }} context
 */
export function classifyRcBranches(branches, { productTagVersion = null, mergedRcVersions = [] } = {}) {
  const open = [];
  const leftovers = [];
  const merged = new Set(mergedRcVersions);

  for (const branch of branches) {
    const version = versionFromRcBranch(branch.name);
    if (!version) continue;
    const released = Boolean(productTagVersion) && compareVersions(version, productTagVersion) <= 0;
    (released || merged.has(version) ? leftovers : open).push({ ...branch, version });
  }

  open.sort((a, b) => compareVersions(a.version, b.version));
  leftovers.sort((a, b) => compareVersions(a.version, b.version));
  return { open, leftovers, latest: open.at(-1) ?? null };
}

/**
 * Product-wide view over its repositories.
 *
 * @param {{ path: string, tags: {name: string}[], released: {version: string}|null, rc: {open: {version: string}[]} }[]} repos
 */
export function productState(repos) {
  const openVersions = [...new Set(repos.flatMap((repo) => repo.rc.open.map((branch) => branch.version)))].sort(
    compareVersions,
  );
  return {
    tagVersion: maxVersion(repos.flatMap((repo) => repo.tags.map((tag) => tag.name))),
    released: maxVersion(repos.map((repo) => repo.released?.version).filter(Boolean)),
    openVersions,
    latestOpen: openVersions.at(-1) ?? null,
  };
}

/** Highest tag across the repositories of one product; `null` when nothing is tagged. */
export function productTagVersion(repoTagLists) {
  return maxVersion(repoTagLists.flat().map((tag) => tag.name));
}
