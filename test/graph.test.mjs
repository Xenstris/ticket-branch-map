import assert from 'node:assert/strict';
import { test } from 'node:test';

import { G, chipsOf, edgeStyle, layoutTicket } from '../public/graph.js';

const item = (branch, overrides = {}) => ({
  key: `repo#${branch}`,
  branch,
  via: { type: 'own', number: 1 },
  flags: [],
  mr: { iid: 1, state: 'opened', draft: false, targetRef: 'main', behindTarget: 0 },
  target: { ref: 'main', exists: true },
  expected: { ref: 'main', reason: 'default' },
  parentKey: null,
  local: null,
  ...overrides,
});
const trunk = (ref) => ({ ref, label: ref, kind: 'default', exists: true });
const lane = (items, trunks = [trunk('main')], deployments = []) => ({ repo: 'repo', name: 'repo', items, trunks, deployments });
const ticket = (...lanes) => ({ groups: [{ key: 'g', label: 'Group', lanes }] });

test('a merge request is one line from its branch to its destination', () => {
  const layout = layoutTicket(ticket(lane([item('feat/a')])));
  assert.equal(layout.nodes.length, 1);
  assert.equal(layout.trunks.length, 1);
  assert.deepEqual(layout.edges.map((edge) => [edge.kind, edge.style]), [['mr', 'open']]);
  const [node] = layout.nodes;
  const [box] = layout.trunks;
  assert.equal(node.cy, box.cy, 'the first destination is level with the first branch');
  assert.ok(box.x >= node.x + node.width + G.gapX);
  assert.equal(layout.width, box.x + box.width + G.padX);
});

test('the expected destination gets its own dashed line only when it differs from the target', () => {
  const same = layoutTicket(ticket(lane([item('feat/a')])));
  assert.equal(same.edges.filter((edge) => edge.kind === 'expected').length, 0);

  const trunks = [{ ...trunk('rc-new'), kind: 'rc' }, { ...trunk('rc-old'), kind: 'rc' }];
  const wrong = item('feat/a', {
    mr: { iid: 1, state: 'opened', draft: false, targetRef: 'rc-old', behindTarget: 0 },
    target: { ref: 'rc-old', exists: true },
    expected: { ref: 'rc-new', reason: 'latest-rc' },
    flags: [{ level: 'warn', code: 'target-not-latest', text: '' }],
  });
  const layout = layoutTicket(ticket(lane([wrong], trunks)));
  assert.deepEqual(layout.edges.map((edge) => [edge.kind, edge.style]).sort(), [['expected', 'expected'], ['mr', 'warn']]);
  const mr = layout.edges.find((edge) => edge.kind === 'mr');
  const expected = layout.edges.find((edge) => edge.kind === 'expected');
  assert.notEqual(mr.path.split(' ')[0], expected.path.split(' ')[0], 'the two lines leave the box at different heights');
});

test('a branch without a merge request shows only where one should point', () => {
  const orphan = item('feat/a', { mr: null, target: null, flags: [{ level: 'info', code: 'no-mr', text: '' }] });
  const layout = layoutTicket(ticket(lane([orphan])));
  assert.deepEqual(layout.edges.map((edge) => edge.kind), ['expected']);
});

test('a stacked branch sits under its parent, indented, joined by an elbow', () => {
  const parent = item('feat/a');
  const child = item('fix/a', {
    parentKey: parent.key,
    mr: { iid: 2, state: 'opened', draft: false, targetRef: 'feat/a', behindTarget: 0 },
    target: { ref: 'feat/a', exists: true },
    expected: { ref: 'feat/a', reason: 'stack' },
  });
  const layout = layoutTicket(ticket(lane([child, parent])));
  const [first, second] = layout.nodes;
  assert.deepEqual([first.item.branch, second.item.branch], ['feat/a', 'fix/a'], 'the parent comes first whatever the input order');
  assert.equal(second.x - first.x, G.indent);
  assert.ok(second.y >= first.y + first.height);
  const elbow = layout.edges.find((edge) => edge.item === child);
  assert.match(elbow.path, / V/, 'ends with a vertical run up into the parent');
  assert.ok(elbow.label.x < second.x && elbow.label.x > first.x, 'its label sits in the indent');
  assert.equal(layout.edges.filter((edge) => edge.kind === 'expected').length, 0, 'a stack is not judged against the candidates');
  // The parent's line starts beyond the indented child, so it cannot run through it.
  const parentEdge = layout.edges.find((edge) => edge.item === parent);
  assert.ok(parentEdge.path.includes(`L${second.x + second.width},`));
});

test('finished branches are drawn compact and can be hidden, except under unfinished work', () => {
  const merged = (branch, extra = {}) => item(branch, { mr: { iid: 3, state: 'merged', draft: false, targetRef: 'main' }, expected: null, ...extra });
  const parent = merged('feat/base');
  const live = item('fix/on-base', { parentKey: parent.key, mr: { iid: 4, state: 'opened', draft: false, targetRef: 'feat/base', behindTarget: 0 }, expected: { ref: 'feat/base', reason: 'stack' } });
  const other = merged('feat/old');
  const everything = layoutTicket(ticket(lane([parent, live, other])));
  assert.equal(everything.nodes.length, 3);
  assert.equal(everything.nodes.find((node) => node.item === other).height, G.nodeHCompact);
  assert.equal(everything.hidden, 0);

  const liveOnly = layoutTicket(ticket(lane([parent, live, other])), { showFinished: false });
  assert.deepEqual(liveOnly.nodes.map((node) => node.item.branch), ['feat/base', 'fix/on-base']);
  assert.equal(liveOnly.hidden, 1);
});

test('a wide window stretches the gap and a narrow one tightens the layout', () => {
  const one = ticket(lane([item('feat/a')]));
  const natural = layoutTicket(one).width;
  assert.equal(layoutTicket(one, { availableWidth: natural + 100 }).width, natural + 100);
  assert.equal(layoutTicket(one, { availableWidth: natural + 5000 }).width, natural + (G.gapMax - G.gapX));
  const tight = layoutTicket(one, { availableWidth: natural - 60 });
  assert.equal(tight.labelW, G.labelWTight);
  assert.ok(tight.width < natural);
});

test('lanes stack without overlapping', () => {
  const a = { ...lane([item('feat/a'), item('feat/b')]), repo: 'a' };
  const b = { ...lane([item('feat/c')]), repo: 'b' };
  const layout = layoutTicket(ticket(a, b));
  const bands = layout.bands.filter((band) => band.type === 'lane');
  assert.equal(bands[1].y, bands[0].y + bands[0].height);
  assert.equal(layout.height, bands[1].y + bands[1].height);
  for (const node of layout.nodes) {
    const band = bands.find((entry) => entry.lane === node.lane);
    assert.ok(node.y >= band.y && node.y + node.height <= band.y + band.height);
  }
});

test('chips summarise findings, deployments and local state', () => {
  const flagged = item('feat/a', {
    flags: [
      { level: 'error', code: 'conflict', text: '' },
      { level: 'warn', code: 'target-not-latest', text: '' },
    ],
    mr: { iid: 1, state: 'opened', draft: true, targetRef: 'main', behindTarget: 7 },
    local: { state: 'ahead', ahead: 2, behind: 0, current: true },
    via: { type: 'parent', number: 1042 },
  });
  const deployments = [
    { environment: 'stg', item: flagged.key, upToDate: false },
    { environment: 'preprod', item: 'someone-else', upToDate: true },
  ];
  assert.deepEqual(
    chipsOf(flagged, deployments).map((chip) => chip.text),
    ['konflikt', 'nie najnowszy RC', 'draft', '7 za celem', 'STG: starszy commit', 'lokalnie +2', 'z #1042'],
  );
  assert.equal(chipsOf(flagged, deployments, { showVia: false }).some((chip) => chip.level === 'via'), false);
  assert.deepEqual(chipsOf(item('feat/clean')), []);
});

test('the line style follows the state and the worst finding about the target', () => {
  assert.equal(edgeStyle(item('a')), 'open');
  assert.equal(edgeStyle(item('a', { mr: { state: 'opened', draft: true } })), 'draft');
  assert.equal(edgeStyle(item('a', { mr: { state: 'merged' } })), 'merged');
  assert.equal(edgeStyle(item('a', { mr: { state: 'closed' } })), 'closed');
  assert.equal(edgeStyle(item('a', { flags: [{ code: 'target-missing' }] })), 'error');
  assert.equal(edgeStyle(item('a', { flags: [{ code: 'target-skips-rc' }] })), 'warn');
  assert.equal(edgeStyle(item('a', { flags: [{ code: 'conflict' }] })), 'open', 'a conflict is about the content, not about where it points');
});
