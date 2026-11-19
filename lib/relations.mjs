/**
 * The judgement calls of the tool, kept pure so they can be tested without GitLab:
 * where a branch came from, where its merge request should point, and what is wrong with where
 * it points now. Texts are Polish because they are shown to the user as they are.
 */

import { compareVersions, versionFromRcBranch } from './versions.mjs';

/** `release-candidate/1.16.0` -> `RC 1.16.0`; other branch names stay as they are. */
export function refLabel(ref) {
  const version = versionFromRcBranch(ref);
  return version ? `RC ${version}` : String(ref);
}

/** Polish plural of "commit" with the number, e.g. `1 commit`, `3 commity`, `12 commitów`, `100+ commitów`. */
export function commits(count, capped = false) {
  if (capped) return `${count}+ commitów`;
  const lastTwo = count % 100;
  const last = count % 10;
  if (count === 1) return '1 commit';
  if (last >= 2 && last <= 4 && !(lastTwo >= 12 && lastTwo <= 14)) return `${count} commity`;
  return `${count} commitów`;
}

/** The same in the genitive, for "brakuje ...": `1 commita`, `3 commitów`. */
export function commitsMissing(count, capped = false) {
  if (capped) return `${count}+ commitów`;
  return count === 1 ? '1 commita' : `${count} commitów`;
}

/**
 * What a branch name is in a repository.
 *
 * @returns {{ ref: string, label: string, exists: boolean, version: string|null,
 *   kind: 'default'|'rc'|'candidate'|'branch'|'missing',
 *   rcState: 'latest'|'open'|'leftover'|'missing'|null }}
 */
export function describeRef(ref, repo) {
  const version = versionFromRcBranch(ref);
  const exists = Boolean(repo.branches[ref]);
  let kind;
  let rcState = null;

  if (ref === repo.defaultBranch) kind = 'default';
  else if (version) {
    kind = 'rc';
    if (!exists) rcState = 'missing';
    else if (repo.rc.latest?.name === ref) rcState = 'latest';
    else if (repo.rc.open.some((branch) => branch.name === ref)) rcState = 'open';
    else rcState = 'leftover';
  } else if (repo.candidates.includes(ref)) kind = 'candidate';
  else kind = exists ? 'branch' : 'missing';

  return { ref, label: refLabel(ref), exists, version, kind, rcState };
}

/**
 * The branch another branch most plausibly came out of: the candidate it has the fewest commits
 * of its own against. When two candidates tie, the fork point lies on both lines, so the declared
 * target wins, then the one the branch is least behind.
 *
 * @param {{ ref: string, kind: string, version?: string|null, ahead: number, behind: number }[]} relations
 */
export function pickBase(relations, targetRef = null) {
  const usable = relations.filter((relation) => Number.isFinite(relation.ahead) && Number.isFinite(relation.behind));
  if (usable.length === 0) return null;
  const kindRank = { branch: 0, candidate: 1, rc: 1, default: 2 };
  return [...usable].sort(
    (a, b) =>
      a.ahead - b.ahead ||
      Number(b.ref === targetRef) - Number(a.ref === targetRef) ||
      a.behind - b.behind ||
      (kindRank[a.kind] ?? 3) - (kindRank[b.kind] ?? 3) ||
      (a.version && b.version ? compareVersions(b.version, a.version) : 0),
  )[0];
}

/**
 * Where a merge request from this repository should point right now.
 *
 * - stacked on another feature branch: that branch, nothing to judge;
 * - QA repository: its release-candidate branch when one is open, otherwise the default branch;
 * - product repository: the newest open release candidate, otherwise the default branch.
 *
 * @param {{ target: ReturnType<typeof describeRef>|null, repo: object, productLatestOpen?: string|null }} input
 */
export function expectedTarget({ target, repo, productLatestOpen = null }) {
  if (target?.kind === 'branch') return { ref: target.ref, reason: 'stack' };
  if (repo.candidates.length) return { ref: repo.candidates.at(-1), reason: 'candidate' };
  if (repo.rc.latest) return { ref: repo.rc.latest.name, reason: 'latest-rc' };
  const missingVersion =
    repo.role === 'product' && productLatestOpen && !repo.branches[`release-candidate/${productLatestOpen}`]
      ? productLatestOpen
      : null;
  return { ref: repo.defaultBranch, reason: missingVersion ? 'rc-not-in-repo' : 'default', missingVersion };
}

/** What happened to a merged merge request's changes. */
export function mergedOutcome({ target, repo }) {
  if (target.kind === 'rc') {
    const released = repo.released && compareVersions(target.version, repo.released.version) <= 0;
    return released
      ? { type: 'released', version: target.version, text: `wydane w ${target.version}` }
      : { type: 'in-rc', version: target.version, text: `w ${target.label}, jeszcze niewydane` };
  }
  if (target.kind === 'default') return { type: 'in-default', text: `w ${target.ref}` };
  return { type: 'in-branch', branch: target.ref, text: `w ${target.ref}` };
}

const relationTo = (relations, ref) => relations.find((relation) => relation.ref === ref) ?? null;

const retargetHint = (relation) => {
  if (!relation || !Number.isFinite(relation.behind)) return '';
  return relation.behind === 0
    ? ' (przepięcie nie wymaga rebase’u)'
    : ` (po przepięciu ${commits(relation.behind, relation.behindCapped)} w plecy)`;
};

/**
 * Everything worth saying about one open merge request, most serious first.
 *
 * @param {{
 *   mr: { hasConflicts: boolean, behindTarget: number|null, pipelineStatus: string|null, discussionsResolved: boolean },
 *   target: ReturnType<typeof describeRef>, expected: ReturnType<typeof expectedTarget>,
 *   relations: object[], base: object|null, repo: object,
 * }} input
 * @returns {{ level: 'error'|'warn'|'info', code: string, text: string }[]}
 */
export function openItemFlags({ mr, target, expected, relations, base, repo }) {
  const flags = [];
  const expectedLabel = refLabel(expected.ref);
  const toExpected = relationTo(relations, expected.ref);

  if (!target.exists) {
    const released = target.version && repo.released && compareVersions(target.version, repo.released.version) <= 0;
    flags.push({
      level: 'error',
      code: 'target-missing',
      text: `celuje w ${target.label}, a tej gałęzi nie ma już w repozytorium${released ? ' (wersja wydana)' : ''}; powinien celować w ${expectedLabel}${retargetHint(toExpected)}`,
    });
  } else if (mr.hasConflicts) {
    flags.push({ level: 'error', code: 'conflict', text: `konflikt z ${target.label}` });
  }

  if (target.exists && expected.ref !== target.ref) {
    if (target.rcState === 'leftover') {
      flags.push({
        level: 'warn',
        code: 'target-released',
        text: `celuje w ${target.label}, a ta wersja jest już wydana; powinien celować w ${expectedLabel}${retargetHint(toExpected)}`,
      });
    } else if (expected.reason === 'latest-rc' && target.kind === 'rc') {
      flags.push({
        level: 'warn',
        code: 'target-not-latest',
        text: `celuje w ${target.label}, a najnowszy to ${expectedLabel}${retargetHint(toExpected)}`,
      });
    } else if (expected.reason === 'latest-rc') {
      flags.push({
        level: 'warn',
        code: 'target-skips-rc',
        text: `celuje w ${target.label}, a otwarty jest ${expectedLabel}${retargetHint(toExpected)}`,
      });
    } else if (expected.reason === 'candidate') {
      flags.push({
        level: 'warn',
        code: 'target-skips-candidate',
        text: `celuje w ${target.label}, a testy pod najbliższe wydanie zbiera ${expectedLabel}${retargetHint(toExpected)}`,
      });
    } else {
      flags.push({
        level: 'warn',
        code: 'target-unexpected',
        text: `celuje w ${target.label}, a w tym repozytorium nie ma otwartego RC; powinien celować w ${expectedLabel}${retargetHint(toExpected)}`,
      });
    }
  }

  if (expected.reason === 'rc-not-in-repo') {
    flags.push({
      level: 'info',
      code: 'rc-not-in-repo',
      text: `RC ${expected.missingVersion} jest już w innych repozytoriach produktu, ale nie tutaj, więc celem zostaje ${expectedLabel}`,
    });
  }

  const toTarget = relationTo(relations, target.ref);
  if (base && target.exists && base.ref !== target.ref && toTarget && !toTarget.aheadCapped && !base.aheadCapped) {
    const extra = toTarget.ahead - base.ahead;
    if (extra > 0) {
      flags.push({
        level: 'warn',
        code: 'base-differs',
        text: `wyszła z ${refLabel(base.ref)}, a celuje w ${target.label}: MR niesie ${commits(extra)} spoza tej gałęzi`,
      });
    }
  }

  if (target.exists && Number.isFinite(mr.behindTarget) && mr.behindTarget > 0) {
    flags.push({ level: 'info', code: 'behind', text: `${commits(mr.behindTarget)} za ${target.label}, do rebase’u` });
  }
  if (mr.pipelineStatus === 'failed') {
    flags.push({ level: 'warn', code: 'pipeline-failed', text: 'pipeline MR-a zakończył się błędem' });
  }
  if (mr.discussionsResolved === false) {
    flags.push({ level: 'info', code: 'discussions', text: 'nierozwiązane wątki w MR' });
  }

  const order = { error: 0, warn: 1, info: 2 };
  return flags.sort((a, b) => order[a.level] - order[b.level]);
}

/**
 * Flags that only make sense across a ticket's merge requests: one product, several destinations.
 *
 * @param {{ productLabel: string, entries: { repoName: string, target: ReturnType<typeof describeRef> }[] }} input
 */
export function productTargetMismatch({ productLabel, entries }) {
  const identity = (target) => (target.kind === 'rc' ? `rc:${target.version}` : target.kind === 'default' ? 'default' : `ref:${target.ref}`);
  const distinct = new Set(entries.map((entry) => identity(entry.target)));
  if (distinct.size < 2) return null;
  const list = entries.map((entry) => `${entry.repoName} → ${entry.target.label}`).join(', ');
  return { level: 'warn', code: 'product-mismatch', text: `MR-y ${productLabel} celują w różne miejsca: ${list}` };
}

// ---------------------------------------------------------------------------------------------
// Release candidates against each other and against the default branch

/**
 * Does a branch contain everything its base has? Compared by commit, with one refinement: a
 * commit of the base that the branch carries under another SHA (same author and subject, which
 * is what a rebase of the base leaves behind) is not missing. It is a stale copy, and the branch
 * needs a rebase, not the change.
 *
 * @param {{
 *   ahead: { count: number, capped: boolean, commits: {title: string, author: string}[] },
 *   behind: { count: number, capped: boolean, commits: {title: string, author: string}[] },
 * }} ranges `ahead`: on the branch, not on the base; `behind`: on the base, not on the branch
 */
export function containment({ ahead, behind }) {
  const signature = (commit) => `${commit.author ?? ''}\u0000${commit.title ?? ''}`;
  const copies = new Map();
  for (const commit of ahead.commits) copies.set(signature(commit), (copies.get(signature(commit)) ?? 0) + 1);

  const missing = [];
  let rewritten = 0;
  for (const commit of behind.commits) {
    const left = copies.get(signature(commit)) ?? 0;
    if (left > 0) {
      copies.set(signature(commit), left - 1);
      rewritten += 1;
    } else missing.push(commit);
  }

  let status = 'contains';
  if (behind.count > 0) status = missing.length === 0 && !behind.capped ? 'stale-copies' : 'missing';
  return {
    status,
    ahead: ahead.count,
    aheadCapped: ahead.capped,
    behind: behind.count,
    behindCapped: behind.capped,
    rewritten,
    missingCount: missing.length,
    missing: missing.slice(0, 20),
    /** With more than a hundred commits on either side the pairing above saw only part of them. */
    approximate: ahead.capped || behind.capped,
  };
}

/** One sentence for "does it contain its base", with how serious the answer is. */
export function containmentText(relation, baseLabel) {
  if (relation.status === 'contains') return { level: 'ok', text: `zawiera cały ${baseLabel}` };
  if (relation.status === 'stale-copies') {
    return {
      level: 'warn',
      text: `ma zmiany z ${baseLabel}, ale w commitach sprzed rebase’u (${relation.rewritten}); do rebase’u`,
    };
  }
  const stale = relation.rewritten ? `, a ${commits(relation.rewritten)} ma w wersji sprzed rebase’u` : '';
  return {
    level: 'error',
    text: `brakuje ${commitsMissing(relation.missingCount, relation.behindCapped)} z ${baseLabel}${stale}`,
  };
}

/**
 * One sentence for "does the default branch have what this candidate has".
 *
 * @param {{ ahead: number, aheadCapped: boolean, sameContent: boolean|null, released: boolean, defaultBranch: string }} input
 */
export function unreleasedText({ ahead, aheadCapped, sameContent, released, defaultBranch }) {
  if (ahead === 0) return { level: 'ok', text: `${defaultBranch} ma wszystko z tej gałęzi` };
  if (sameContent) return { level: 'ok', text: `${defaultBranch} ma tę samą treść, pod innymi commitami` };
  if (released) {
    return {
      level: 'info',
      text: `wersja wydana, ale ${defaultBranch} nie ma jej commitów pod tymi samymi SHA (${ahead}${aheadCapped ? '+' : ''})`,
    };
  }
  return { level: 'info', text: `czeka na wydanie: ${commits(ahead, aheadCapped)} ponad ${defaultBranch}` };
}
