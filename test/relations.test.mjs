import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  commits,
  commitsMissing,
  containment,
  containmentText,
  describeRef,
  expectedTarget,
  mergedOutcome,
  openItemFlags,
  pickBase,
  productTargetMismatch,
  refLabel,
  unreleasedText,
} from '../lib/relations.mjs';

/** A product repository with two open candidates, the way cryden-portal looked on 2026-11-10. */
const portal = {
  role: 'product',
  defaultBranch: 'main',
  branches: {
    main: {},
    'release-candidate/1.15.0': {},
    'release-candidate/1.16.0': {},
    'release-candidate/1.13.0': {},
    'feat/1174-integration-access': {},
  },
  rc: {
    open: [
      { name: 'release-candidate/1.15.0', version: '1.15.0' },
      { name: 'release-candidate/1.16.0', version: '1.16.0' },
    ],
    latest: { name: 'release-candidate/1.16.0', version: '1.16.0' },
  },
  candidates: [],
  released: { version: '1.14.0' },
};

/** A product repository whose candidates were deleted after the release, like cryden-api. */
const api = { role: 'product', defaultBranch: 'main', branches: { main: {} }, rc: { open: [], latest: null }, candidates: [], released: { version: '1.15.0' } };
const library = { role: 'library', defaultBranch: 'main', branches: { main: {} }, rc: { open: [], latest: null }, candidates: [], released: null };
const qa = { role: 'qa', defaultBranch: 'develop', branches: { develop: {}, 'rc-next': {} }, rc: { open: [], latest: null }, candidates: ['rc-next'], released: null };

const relation = (ref, kind, ahead, behind, version = null) => ({ ref, kind, version, ahead, behind });

test('labels and Polish plurals', () => {
  assert.equal(refLabel('release-candidate/1.16.0'), 'RC 1.16.0');
  assert.equal(refLabel('main'), 'main');
  assert.deepEqual([1, 2, 5, 12, 22, 25].map((count) => commits(count)), ['1 commit', '2 commity', '5 commitów', '12 commitów', '22 commity', '25 commitów']);
  assert.equal(commits(100, true), '100+ commitów');
});

test('a branch name is described by what it is in the repository', () => {
  assert.deepEqual(
    [describeRef('main', portal), describeRef('release-candidate/1.16.0', portal), describeRef('release-candidate/1.15.0', portal)].map((ref) => [ref.kind, ref.rcState]),
    [['default', null], ['rc', 'latest'], ['rc', 'open']],
  );
  assert.equal(describeRef('release-candidate/1.13.0', portal).rcState, 'leftover');
  assert.equal(describeRef('release-candidate/6.19.0', api).rcState, 'missing');
  assert.equal(describeRef('feat/1174-integration-access', portal).kind, 'branch');
  assert.equal(describeRef('feat/deleted', portal).kind, 'missing');
  assert.equal(describeRef('rc-next', qa).kind, 'candidate');
});

test('a branch came out of the candidate it has the fewest commits of its own against', () => {
  const base = pickBase([relation('main', 'default', 12, 0), relation('release-candidate/1.16.0', 'rc', 3, 1, '1.16.0')], 'main');
  assert.equal(base.ref, 'release-candidate/1.16.0');
});

test('when candidates tie the declared target is taken as the origin', () => {
  // The real case: +2 against both candidates, behind only the one it targets.
  const relations = [
    relation('main', 'default', 7, 0),
    relation('release-candidate/1.15.0', 'rc', 2, 2, '1.15.0'),
    relation('release-candidate/1.16.0', 'rc', 2, 0, '1.16.0'),
  ];
  assert.equal(pickBase(relations, 'release-candidate/1.15.0').ref, 'release-candidate/1.15.0');
  assert.equal(pickBase(relations, 'main').ref, 'release-candidate/1.16.0', 'without the target in the tie, the one it is least behind');
  assert.equal(pickBase([], 'main'), null);
});

test('merge requests should point at the newest open candidate', () => {
  const target = describeRef('release-candidate/1.15.0', portal);
  assert.deepEqual(expectedTarget({ target, repo: portal }), { ref: 'release-candidate/1.16.0', reason: 'latest-rc' });
});

test('without a candidate branch in the repository the default branch is the target', () => {
  const target = describeRef('main', api);
  assert.deepEqual(expectedTarget({ target, repo: api, productLatestOpen: '1.16.0' }), { ref: 'main', reason: 'rc-not-in-repo', missingVersion: '1.16.0' });
  assert.equal(expectedTarget({ target, repo: library, productLatestOpen: '1.16.0' }).reason, 'default');
});

test('a merge request stacked on another branch is judged by that branch, not by the candidates', () => {
  const target = describeRef('feat/1174-integration-access', portal);
  assert.deepEqual(expectedTarget({ target, repo: portal }), { ref: 'feat/1174-integration-access', reason: 'stack' });
});

test('the QA repository collects tests in its candidate branch when one is open', () => {
  assert.deepEqual(expectedTarget({ target: describeRef('develop', qa), repo: qa }), { ref: 'rc-next', reason: 'candidate' });
});

const quietMr = { hasConflicts: false, behindTarget: 0, pipelineStatus: 'success', discussionsResolved: true };

test('an older open candidate as target is flagged, with what re-targeting costs', () => {
  const target = describeRef('release-candidate/1.15.0', portal);
  const expected = expectedTarget({ target, repo: portal });
  const relations = [relation('release-candidate/1.15.0', 'rc', 2, 2, '1.15.0'), relation('release-candidate/1.16.0', 'rc', 2, 0, '1.16.0')];
  const flags = openItemFlags({ mr: { ...quietMr, behindTarget: 2 }, target, expected, relations, base: relations[0], repo: portal });
  assert.deepEqual(flags.map((flag) => [flag.level, flag.code]), [['warn', 'target-not-latest'], ['info', 'behind']]);
  assert.match(flags[0].text, /celuje w RC 1\.15\.0, a najnowszy to RC 1\.16\.0 \(przepięcie nie wymaga rebase’u\)/);
});

test('a deleted target is an error that names where to point instead', () => {
  const target = describeRef('release-candidate/6.19.0', api);
  const expected = expectedTarget({ target, repo: api, productLatestOpen: '6.19.0' });
  const relations = [{ ...relation('main', 'default', 6, 13), behindCapped: false }];
  const flags = openItemFlags({ mr: { ...quietMr, hasConflicts: true }, target, expected, relations, base: relations[0], repo: api });
  assert.equal(flags[0].code, 'target-missing');
  assert.match(flags[0].text, /powinien celować w main \(po przepięciu 13 commitów w plecy\)/);
  assert.equal(flags.some((flag) => flag.code === 'conflict'), false, 'GitLab reports a conflict for a missing target; it is not a real one');
  assert.equal(flags.some((flag) => flag.code === 'rc-not-in-repo'), true);
});

test('pointing at the default branch while a candidate is open is flagged', () => {
  const target = describeRef('main', portal);
  const flags = openItemFlags({ mr: quietMr, target, expected: expectedTarget({ target, repo: portal }), relations: [], base: null, repo: portal });
  assert.deepEqual(flags.map((flag) => flag.code), ['target-skips-rc']);
});

test('a branch cut from one line and pointed at another carries foreign commits', () => {
  const target = describeRef('main', library);
  const relations = [relation('main', 'default', 9, 0), relation('rc-old', 'branch', 2, 0)];
  const flags = openItemFlags({ mr: quietMr, target, expected: { ref: 'main', reason: 'default' }, relations, base: relations[1], repo: library });
  assert.deepEqual(flags.map((flag) => flag.code), ['base-differs']);
  assert.match(flags[0].text, /MR niesie 7 commitów spoza tej gałęzi/);
});

test('a healthy merge request raises nothing', () => {
  const target = describeRef('release-candidate/1.16.0', portal);
  const flags = openItemFlags({ mr: quietMr, target, expected: expectedTarget({ target, repo: portal }), relations: [], base: null, repo: portal });
  assert.deepEqual(flags, []);
});

test('conflicts, a failed pipeline and open threads are reported in order of severity', () => {
  const target = describeRef('release-candidate/1.16.0', portal);
  const flags = openItemFlags({
    mr: { hasConflicts: true, behindTarget: 4, pipelineStatus: 'failed', discussionsResolved: false },
    target,
    expected: expectedTarget({ target, repo: portal }),
    relations: [],
    base: null,
    repo: portal,
  });
  assert.deepEqual(flags.map((flag) => flag.code), ['conflict', 'pipeline-failed', 'behind', 'discussions']);
});

test('merged changes are released once the repository shipped that version', () => {
  assert.equal(mergedOutcome({ target: describeRef('release-candidate/1.13.0', portal), repo: portal }).type, 'released');
  assert.deepEqual(mergedOutcome({ target: describeRef('release-candidate/1.15.0', portal), repo: portal }), {
    type: 'in-rc',
    version: '1.15.0',
    text: 'w RC 1.15.0, jeszcze niewydane',
  });
  assert.equal(mergedOutcome({ target: describeRef('main', library), repo: library }).type, 'in-default');
  assert.equal(mergedOutcome({ target: describeRef('feat/1174-integration-access', portal), repo: portal }).type, 'in-branch');
});

test('merge requests of one product pointing at different places are called out once', () => {
  const entries = [
    { repoName: 'cryden-portal', target: describeRef('release-candidate/1.15.0', portal) },
    { repoName: 'cryden-api', target: describeRef('main', api) },
  ];
  const mismatch = productTargetMismatch({ productLabel: 'Cryden', entries });
  assert.equal(mismatch.code, 'product-mismatch');
  assert.match(mismatch.text, /cryden-portal → RC 1\.15\.0, cryden-api → main/);
  assert.equal(productTargetMismatch({ productLabel: 'Cryden', entries: [entries[0], entries[0]] }), null);
});

// --- release candidates against each other and against the default branch -----------------------

const commit = (title, author = 'Dev') => ({ id: title.slice(0, 8), title, author, at: '2026-11-10T09:00:00Z' });
const range = (...list) => ({ count: list.length, capped: false, commits: list });

test('a branch with nothing of its base missing contains it', () => {
  const relation = containment({ ahead: range(commit('feat: a'), commit('feat: b')), behind: range() });
  assert.equal(relation.status, 'contains');
  assert.deepEqual(containmentText(relation, 'main'), { level: 'ok', text: 'zawiera cały main' });
});

test('commits of the base the branch lacks are listed as missing', () => {
  // cryden-portal on 2026-11-10: the newest candidate had not picked up the 1265 merge.
  const relation = containment({
    ahead: range(),
    behind: range(commit("Merge branch 'feat/1265-integration-created-at' into 'release-candidate/1.15.0'"), commit('feat(1265): integration and bucket creation date')),
  });
  assert.equal(relation.status, 'missing');
  assert.equal(relation.missingCount, 2);
  assert.deepEqual(relation.missing.map((entry) => entry.title), [
    "Merge branch 'feat/1265-integration-created-at' into 'release-candidate/1.15.0'",
    'feat(1265): integration and bucket creation date',
  ]);
  assert.deepEqual(containmentText(relation, 'RC 1.15.0'), { level: 'error', text: 'brakuje 2 commitów z RC 1.15.0' });
});

test('a commit the branch holds under another SHA is a stale copy, not a missing change', () => {
  // The base was rebased: same authors and subjects, new SHAs. The branch has the old ones.
  const relation = containment({
    ahead: range(commit('feat: a'), commit('feat: b'), commit('own work')),
    behind: range(commit('feat: a'), commit('feat: b')),
  });
  assert.equal(relation.status, 'stale-copies');
  assert.equal(relation.rewritten, 2);
  assert.equal(relation.missingCount, 0);
  assert.equal(containmentText(relation, 'RC 1.15.0').level, 'warn');
  assert.match(containmentText(relation, 'RC 1.15.0').text, /sprzed rebase’u \(2\); do rebase’u/);
});

test('the same subject by another author, or twice, is not paired up by mistake', () => {
  const relation = containment({
    ahead: range(commit('fix: typo', 'Ann')),
    behind: range(commit('fix: typo', 'Ann'), commit('fix: typo', 'Ann'), commit('fix: typo', 'Bob')),
  });
  assert.equal(relation.rewritten, 1);
  assert.equal(relation.missingCount, 2);
  assert.equal(relation.status, 'missing');
  assert.match(containmentText(relation, 'main').text, /^brakuje 2 commitów z main, a 1 commit ma w wersji sprzed rebase’u$/);
});

test('past a hundred commits the answer is marked as approximate and never as "only stale copies"', () => {
  const many = { count: 100, capped: true, commits: Array.from({ length: 100 }, (_, index) => commit(`c${index}`)) };
  const relation = containment({ ahead: many, behind: many });
  assert.equal(relation.approximate, true);
  assert.equal(relation.status, 'missing');
  assert.equal(commitsMissing(100, true), '100+ commitów');
  assert.equal(commitsMissing(1), '1 commita');
});

test('whether the default branch has what a candidate carries', () => {
  const base = { aheadCapped: false, sameContent: false, released: false, defaultBranch: 'main' };
  assert.deepEqual(unreleasedText({ ...base, ahead: 0 }), { level: 'ok', text: 'main ma wszystko z tej gałęzi' });
  assert.deepEqual(unreleasedText({ ...base, ahead: 7 }), { level: 'info', text: 'czeka na wydanie: 7 commitów ponad main' });
  assert.equal(unreleasedText({ ...base, ahead: 30, sameContent: true }).text, 'main ma tę samą treść, pod innymi commitami');
  assert.match(unreleasedText({ ...base, ahead: 2, released: true }).text, /^wersja wydana, ale main nie ma jej commitów pod tymi samymi SHA \(2\)$/);
});
