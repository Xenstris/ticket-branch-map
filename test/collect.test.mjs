import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildModel } from '../lib/collect.mjs';

/**
 * A small GitLab: one product with a backend that has no candidate branch left and a portal with
 * two open candidates, a shared library, and the QA repository. Enough to exercise the whole
 * assembly without the network.
 */
const API = 'g/cryden/cryden-api';
const PORTAL = 'g/cryden/cryden-portal';
const COMMON = 'g/lib/common';
const QA = 'g/qa/tests';

const branch = (name, sha) => ({ name, commit: { id: sha, committed_date: '2026-11-10T09:00:00Z' }, merged: false });
const mr = (project, iid, source, target, state, title, extra = {}) => ({
  id: project.length * 1000 + iid,
  iid,
  title,
  description: '',
  state,
  draft: false,
  source_branch: source,
  target_branch: target,
  created_at: '2026-11-03T10:00:00Z',
  updated_at: '2026-11-10T08:00:00Z',
  merged_at: state === 'merged' ? '2026-11-10T09:19:00Z' : null,
  web_url: `https://gitlab.example/${project}/-/merge_requests/${iid}`,
  sha: null,
  author: { username: 'dev', name: 'Dev Person' },
  references: { full: `${project}!${iid}` },
  has_conflicts: false,
  detailed_merge_status: 'mergeable',
  blocking_discussions_resolved: true,
  ...extra,
});

function world() {
  return {
    projects: {
      [API]: { id: 1, defaultBranch: 'main', branches: [branch('main', 'm1'), branch('feat/1174-integration-access', 'a1')], tags: ['v1.14.0'] },
      [PORTAL]: {
        id: 2,
        defaultBranch: 'main',
        branches: [
          branch('main', 'm2'),
          branch('release-candidate/1.15.0', 'r15'),
          branch('release-candidate/1.16.0', 'r16'),
          branch('feat/1174-integration-access', 'p1'),
        ],
        tags: ['v1.14.0', 'v1.13.0'],
      },
      [COMMON]: { id: 4, defaultBranch: 'main', branches: [branch('main', 'm4'), branch('feat/1174-types', 'c1')], tags: [] },
      [QA]: { id: 3, defaultBranch: 'develop', branches: [branch('develop', 'd1')], tags: [] },
    },
    mrs: {
      [API]: [
        mr(API, 201, 'feat/1174-integration-access', 'main', 'opened', 'feat(1174): share integrations', { has_conflicts: true, detailed_merge_status: 'conflict' }),
        // A release merge lists the tickets it ships; it must not show up under any of them.
        mr(API, 189, 'release-candidate/1.15.0', 'main', 'merged', 'release-candidate/1.15.0', { description: 'Notion: 1174' }),
      ],
      [PORTAL]: [
        mr(PORTAL, 72, 'feat/1174-integration-access', 'release-candidate/1.15.0', 'opened', 'feat(1174): integration access'),
        // No number in the title and the branch is gone: only the per-repository listing finds it.
        mr(PORTAL, 90, 'feat/1265-created-at', 'release-candidate/1.16.0', 'merged', 'feat: dashboard created at'),
      ],
      [COMMON]: [mr(COMMON, 60, 'feat/1174-types', 'main', 'opened', 'feat(1174): types')],
      [QA]: [],
    },
    details: {
      [`${API}!201`]: { diverged_commits_count: 7, head_pipeline: { status: 'success', web_url: 'https://gitlab.example/p/1' } },
      [`${PORTAL}!72`]: { diverged_commits_count: 2, head_pipeline: { status: 'failed', web_url: 'https://gitlab.example/p/2' } },
      [`${COMMON}!60`]: { diverged_commits_count: 0, head_pipeline: null },
    },
    // commits reachable from the right side but not from the left
    counts: { 'm1..a1': 2, 'a1..m1': 7, 'm2..p1': 7, 'p1..m2': 0, 'r15..p1': 2, 'p1..r15': 2, 'r16..p1': 2, 'p1..r16': 0, 'm4..c1': 1, 'c1..m4': 0 },
    // The portal's candidates: 1.15.0 sits on main with two commits; 1.16.0 was cut before them.
    logs: {
      'm2..r15': [{ short_id: 'aaaa1111', title: "Merge branch 'feat/1265' into 'release-candidate/1.15.0'", author_name: 'Dev Person' }, { short_id: 'bbbb2222', title: 'feat(1265): creation date', author_name: 'Dev Person' }],
      'r16..r15': [{ short_id: 'aaaa1111', title: "Merge branch 'feat/1265' into 'release-candidate/1.15.0'", author_name: 'Dev Person' }, { short_id: 'bbbb2222', title: 'feat(1265): creation date', author_name: 'Dev Person' }],
    },
    trees: {},
    deployments: { [PORTAL]: { stg: { ref: 'refs/merge-requests/72/head', sha: 'p1', updated_at: '2026-11-10T08:40:00Z', user: { name: 'Dev Person' } } } },
  };
}

class FakeGitLab {
  constructor(data) {
    this.data = data;
    this.calls = 0;
    this.log = [];
  }

  byId(id) {
    return Object.entries(this.data.projects).find(([, project]) => project.id === Number(id));
  }

  async list(endpoint, query = {}) {
    return this.get(endpoint, { ...query, page: 1 });
  }

  async get(endpoint, query = {}) {
    this.calls += 1;
    this.log.push({ endpoint, query });
    let match;

    if (/^groups\/\d+\/merge_requests$/.test(endpoint)) {
      return Object.values(this.data.mrs)
        .flat()
        .filter((entry) => `${entry.title} ${entry.description}`.includes(query.search));
    }
    if ((match = /^projects\/([^/]+)$/.exec(endpoint)) && !/^\d+$/.test(match[1])) {
      const projectPath = decodeURIComponent(match[1]);
      const project = this.data.projects[projectPath];
      if (!project) throw new Error('404 Project Not Found');
      return { id: project.id, path_with_namespace: projectPath, web_url: `https://gitlab.example/${projectPath}`, default_branch: project.defaultBranch };
    }
    if ((match = /^projects\/(\d+)\/repository\/branches$/.exec(endpoint))) return this.byId(match[1])[1].branches;
    if ((match = /^projects\/(\d+)\/repository\/tags$/.exec(endpoint))) {
      return this.byId(match[1])[1].tags.map((name) => ({ name, commit: { committed_date: '2026-11-09T08:00:00Z' } }));
    }
    if ((match = /^projects\/(\d+)\/merge_requests$/.exec(endpoint))) {
      const [projectPath] = this.byId(match[1]);
      return this.data.mrs[projectPath].filter(
        (entry) =>
          (!query.state || query.state === 'all' || entry.state === query.state) &&
          (!query.source_branch || entry.source_branch === query.source_branch) &&
          (!query.target_branch || entry.target_branch === query.target_branch),
      );
    }
    if ((match = /^projects\/(\d+)\/merge_requests\/(\d+)$/.exec(endpoint))) {
      const [projectPath] = this.byId(match[1]);
      const found = this.data.mrs[projectPath].find((entry) => entry.iid === Number(match[2]));
      return { ...found, ...this.data.details[`${projectPath}!${match[2]}`] };
    }
    if ((match = /^projects\/(\d+)\/deployments$/.exec(endpoint))) {
      const [projectPath] = this.byId(match[1]);
      const deployment = this.data.deployments[projectPath]?.[query.environment];
      return deployment ? [deployment] : [];
    }
    if (/^projects\/\d+\/repository\/commits$/.test(endpoint)) {
      return this.data.logs[query.ref_name] ?? Array.from({ length: this.data.counts[query.ref_name] ?? 0 }, () => ({}));
    }
    if (/^projects\/\d+\/repository\/tree$/.test(endpoint)) {
      return this.data.trees[query.ref] ?? [{ mode: '040000', id: `tree-of-${query.ref}`, name: 'src' }];
    }
    throw new Error(`unexpected endpoint ${endpoint}`);
  }
}

const config = {
  gitlab: {
    groupId: 9,
    environments: ['stg'],
    products: [{ name: 'cryden', label: 'Cryden', repos: [API, PORTAL] }],
    libraries: { [COMMON]: 'cryden' },
    qa: { project: QA, localPath: null, candidateBranch: '^rc-next$' },
  },
  tickets: { aliases: {} },
};

const ticket = (number, extra = {}) => ({
  number,
  title: `Ticket ${number}`,
  url: `https://notion.example/${number}`,
  pageId: `page${number}`,
  status: 'In QA',
  qaAutomated: null,
  priority: null,
  flag: null,
  types: [],
  tags: [],
  assigneeIds: ['dev'],
  qaAssigneeIds: ['me'],
  releaseVersionIds: [],
  parentIds: [],
  subtaskIds: [],
  products: ['cryden'],
  createdAt: '2026-09-24T09:05:08.740Z',
  editedAt: '2026-11-10T07:48:32.656Z',
  ...extra,
});

const snapshot = {
  fetchedAt: '2026-11-10T13:00:00Z',
  me: { id: 'me', name: 'Me' },
  tickets: [ticket(1174), ticket(1265, { status: 'Release Candidate' })],
  related: {},
  releaseVersions: {},
  users: { me: 'Me', dev: 'Dev Person' },
  warnings: [],
};

async function build(overrides = {}) {
  const gitlab = new FakeGitLab(world());
  const store = new Map();
  const cache = { get: (key) => store.get(key), set: (key, value) => store.set(key, value) };
  const model = await buildModel({ config, snapshot, gitlab, cache, ...overrides });
  return { model, gitlab };
}

const itemsOf = (builtTicket) => builtTicket.groups.flatMap((group) => group.lanes).flatMap((lane) => lane.items);
const laneOf = (builtTicket, name) => builtTicket.groups.flatMap((group) => group.lanes).find((lane) => lane.name === name);

test('release state comes from tags, merged candidates and the branches that exist', async () => {
  const { model } = await build();
  assert.deepEqual(model.products, [
    { name: 'cryden', label: 'Cryden', repos: [API, PORTAL], tagVersion: '1.14.0', released: '1.15.0', openVersions: ['1.15.0', '1.16.0'], latestOpen: '1.16.0' },
  ]);
  const api = model.repos.find((repo) => repo.path === API);
  assert.deepEqual(api.released, { version: '1.15.0', source: 'merge', at: '2026-11-10T09:19:00Z' });
  assert.deepEqual(api.rcOpen, []);
  assert.deepEqual(model.repos.find((repo) => repo.path === PORTAL).rcOpen.map((rc) => rc.version), ['1.15.0', '1.16.0']);
  assert.deepEqual(model.warnings, []);
});

test('a ticket gathers its branches across repositories, sorted into lanes', async () => {
  const { model } = await build();
  const built = model.tickets.find((entry) => entry.number === 1174);
  assert.deepEqual(built.groups.map((group) => [group.key, group.lanes.map((lane) => lane.name)]), [['cryden', ['cryden-api', 'cryden-portal', 'common']]]);
  assert.deepEqual(itemsOf(built).map((item) => [item.repo, item.mr.iid]), [[API, 201], [PORTAL, 72], [COMMON, 60]]);
  assert.deepEqual(built.roles, ['qa']);
  assert.deepEqual(built.counts, { items: 3, open: 3, merged: 0, errors: 1, warnings: 3 });
});

test('an older candidate as target is flagged and the newest one is marked as expected', async () => {
  const { model } = await build();
  const lane = laneOf(model.tickets.find((entry) => entry.number === 1174), 'cryden-portal');
  const [item] = lane.items;
  assert.equal(item.target.rcState, 'open');
  assert.deepEqual(item.expected, { ref: 'release-candidate/1.16.0', reason: 'latest-rc' });
  assert.equal(item.base.ref, 'release-candidate/1.15.0');
  assert.deepEqual(
    item.relations.map((relation) => [relation.label, relation.ahead, relation.behind]).sort(),
    [['RC 1.15.0', 2, 2], ['RC 1.16.0', 2, 0], ['main', 7, 0]],
  );
  assert.deepEqual(item.flags.map((flag) => flag.code), ['target-not-latest', 'pipeline-failed', 'behind']);
  assert.equal(item.mr.behindTarget, 2);
  assert.deepEqual(lane.trunks.map((trunk) => [trunk.label, trunk.expected, trunk.targetedByOpen]), [
    ['RC 1.16.0', true, false],
    ['RC 1.15.0', false, true],
    ['main', false, false],
  ]);
  assert.deepEqual(lane.deployments.map((deployment) => [deployment.environment, deployment.item, deployment.upToDate]), [['stg', item.key, true]]);
});

test('where the candidate branch does not exist yet the default branch is accepted, with the reason', async () => {
  const { model } = await build();
  const built = model.tickets.find((entry) => entry.number === 1174);
  const lane = laneOf(built, 'cryden-api');
  const [item] = lane.items;
  assert.deepEqual(item.expected, { ref: 'main', reason: 'rc-not-in-repo', missingVersion: '1.16.0' });
  assert.deepEqual(item.flags.map((flag) => flag.code), ['conflict', 'rc-not-in-repo', 'behind']);
  assert.deepEqual(lane.trunks.map((trunk) => [trunk.label, trunk.rcState, trunk.expected]), [
    ['RC 1.16.0', 'absent', false],
    ['main', null, true],
  ]);
  assert.ok(built.problems.some((problem) => problem.code === 'product-mismatch' && /cryden-api → main/.test(problem.text)));
  assert.ok(built.problems.some((problem) => problem.code === 'no-qa-branch'));
});

test('a release merge that mentions the ticket is not one of its merge requests', async () => {
  const { model } = await build();
  for (const built of model.tickets) assert.equal(itemsOf(built).some((item) => item.mr?.iid === 189), false);
});

test('a merge request without the number in its title is found through its branch name', async () => {
  const { model } = await build();
  const built = model.tickets.find((entry) => entry.number === 1265);
  const items = itemsOf(built);
  assert.deepEqual(items.map((item) => [item.branch, item.matchedBy, item.exists]), [['feat/1265-created-at', 'branch', false]]);
  assert.deepEqual(items[0].outcome, { type: 'in-rc', version: '1.16.0', text: 'w RC 1.16.0, jeszcze niewydane' });
  // History only: the lane shows where it went, not every open destination.
  assert.deepEqual(laneOf(built, 'cryden-portal').trunks.map((trunk) => trunk.label), ['RC 1.16.0']);
});

test('the group search is bounded by the ticket\'s age', async () => {
  const { gitlab } = await build();
  const searches = gitlab.log.filter((entry) => entry.endpoint === 'groups/9/merge_requests');
  assert.deepEqual(searches.map((entry) => entry.query.search).sort(), ['1174', '1265']);
  assert.equal(searches[0].query.created_after, '2026-08-10T09:05:08.740Z');
});

test('a parent ticket lends its branches to a sub-task, limited to the sub-task\'s product', async () => {
  const sub = ticket(1311, { parentIds: ['page1174'], products: ['heiser'] });
  const { model } = await build({ snapshot: { ...snapshot, tickets: [ticket(1174), sub] } });
  const built = model.tickets.find((entry) => entry.number === 1311);
  // 1174's merge requests are all in Cryden repositories, and this sub-task is about Heiser.
  assert.deepEqual(itemsOf(built), []);

  const cryden = ticket(1312, { parentIds: ['page1174'], products: ['cryden'] });
  const second = await build({ snapshot: { ...snapshot, tickets: [ticket(1174), cryden] } });
  const borrowed = itemsOf(second.model.tickets.find((entry) => entry.number === 1312));
  assert.deepEqual(borrowed.map((item) => item.via), Array(3).fill({ type: 'parent', number: 1174, title: 'Ticket 1174' }));
});

test('one unreadable repository becomes a warning, not a failure', async () => {
  const gitlab = new FakeGitLab(world());
  delete gitlab.data.projects[API];
  const store = new Map();
  const model = await buildModel({ config, snapshot, gitlab, cache: { get: (key) => store.get(key), set: (key, value) => store.set(key, value) } });
  assert.ok(model.warnings.some((warning) => warning.includes(API)));
  assert.equal(model.tickets.length, 2);
  assert.ok(laneOf(model.tickets.find((entry) => entry.number === 1174), 'cryden-portal'));
});

test('candidates are compared with the default branch and with the candidate before them', async () => {
  const { model } = await build();
  const chain = model.repos.find((repo) => repo.path === PORTAL).rcChain;
  assert.deepEqual(chain.open.map((candidate) => [candidate.label, candidate.latest]), [['RC 1.15.0', false], ['RC 1.16.0', true]]);

  const [older, newest] = chain.open;
  assert.deepEqual([older.toDefault.level, older.toDefault.text], ['ok', 'zawiera cały main']);
  assert.equal(older.toPrevious, null);
  assert.equal(older.unreleased.text, 'czeka na wydanie: 2 commity ponad main');
  assert.equal(older.sameContentAsDefault, false);

  assert.equal(newest.toPrevious.base, 'release-candidate/1.15.0');
  assert.deepEqual([newest.toPrevious.level, newest.toPrevious.text], ['error', 'brakuje 2 commitów z RC 1.15.0']);
  assert.deepEqual(newest.toPrevious.missing.map((entry) => entry.title), ["Merge branch 'feat/1265' into 'release-candidate/1.15.0'", 'feat(1265): creation date']);
  assert.match(newest.toPrevious.compareUrl, /\/-\/compare\/release-candidate%2F1\.15\.0\.\.\.release-candidate%2F1\.16\.0$/);
  assert.equal(newest.unreleased.text, 'main ma wszystko z tej gałęzi');

  // A repository without candidate branches has an empty chain, not an error.
  assert.deepEqual(model.repos.find((repo) => repo.path === API).rcChain.open, []);
  assert.equal(model.repos.find((repo) => repo.path === COMMON).rcChain, null);
});

test('a destination that lacks part of an earlier candidate carries the warning onto the map', async () => {
  const { model } = await build();
  const lane = laneOf(model.tickets.find((entry) => entry.number === 1174), 'cryden-portal');
  const byLabel = Object.fromEntries(lane.trunks.map((trunk) => [trunk.label, trunk.health]));
  assert.deepEqual(byLabel['RC 1.16.0'], { level: 'error', text: 'brakuje 2 commitów z RC 1.15.0' });
  assert.equal(byLabel['RC 1.15.0'], null);
  assert.equal(byLabel.main, null);
});

test('a candidate squash-merged into the default branch counts as having the same content', async () => {
  const gitlab = new FakeGitLab(world());
  // Same top-level tree for the candidate's head and for main.
  gitlab.data.trees = { r15: [{ mode: '040000', id: 'same', name: 'src' }], m2: [{ mode: '040000', id: 'same', name: 'src' }] };
  const store = new Map();
  const model = await buildModel({ config, snapshot, gitlab, cache: { get: (key) => store.get(key), set: (key, value) => store.set(key, value) } });
  const [older] = model.repos.find((repo) => repo.path === PORTAL).rcChain.open;
  assert.equal(older.sameContentAsDefault, true);
  assert.equal(older.unreleased.text, 'main ma tę samą treść, pod innymi commitami');
});

test('the model records the newest merge request update for the change check', async () => {
  const { model } = await build();
  assert.equal(model.newestMergeRequestUpdate, '2026-11-10T08:00:00Z');
});
