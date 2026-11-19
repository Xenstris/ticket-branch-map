/**
 * What the local checkout of a repository knows that GitLab does not: branches that were never
 * pushed, commits waiting to be pushed, the branch that is checked out. Read-only: no fetch, no
 * checkout, nothing that moves a ref.
 */

import { execFile } from 'node:child_process';

function git(repoPath, args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', repoPath, ...args], { maxBuffer: 32 * 1024 * 1024, timeout: 20_000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

const SEPARATOR = '\x1f';

/** Parses `git for-each-ref` output produced with the format below. */
export function parseBranchLines(output) {
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, sha, upstream, track, committedAt] = line.split(SEPARATOR);
      return { name, sha, upstream: upstream || null, upstreamGone: track === '[gone]', committedAt };
    });
}

/**
 * @returns {Promise<null | {
 *   path: string, current: string|null, dirty: number,
 *   branches: {name: string, sha: string, upstream: string|null, upstreamGone: boolean, committedAt: string}[],
 * }>} `null` when the path is not a git checkout
 */
export async function readLocalRepo(repoPath) {
  if (!repoPath) return null;
  try {
    const format = ['%(refname:short)', '%(objectname)', '%(upstream:short)', '%(upstream:track)', '%(committerdate:iso-strict)'].join(
      SEPARATOR,
    );
    const [refs, current, status] = await Promise.all([
      git(repoPath, ['for-each-ref', `--format=${format}`, 'refs/heads']),
      git(repoPath, ['branch', '--show-current']),
      // Untracked files are notes and plans kept out of commits on purpose; they are not pending work.
      git(repoPath, ['status', '--porcelain', '--untracked-files=no']),
    ]);
    return {
      path: repoPath,
      current: current.trim() || null,
      dirty: status.split('\n').filter(Boolean).length,
      branches: parseBranchLines(refs),
    };
  } catch {
    return null;
  }
}

/** Commits only in `local` / only in `remote`; `null` when either commit is not in the local object store. */
export async function aheadBehind(repoPath, local, remote) {
  try {
    const output = await git(repoPath, ['rev-list', '--left-right', '--count', `${local}...${remote}`]);
    const [ahead, behind] = output.trim().split(/\s+/).map(Number);
    return { ahead, behind };
  } catch {
    return null;
  }
}

/** Subjects of the commits on `branch` that `base` does not have, newest first. */
export async function subjectsNotIn(repoPath, branch, base, limit = 40) {
  try {
    const output = await git(repoPath, ['log', `--max-count=${limit}`, '--format=%s', `${base}..${branch}`]);
    return output.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}
