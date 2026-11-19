import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyRcBranches, productState, productTagVersion, repoReleased } from '../lib/release.mjs';
import { compareVersions, maxVersion, versionFromRcBranch } from '../lib/versions.mjs';

test('versions parse with and without the tag prefix', () => {
  assert.equal(maxVersion(['v1.9.0', 'v1.14.0', '1.2.3', 'not-a-version']), '1.14.0');
  assert.equal(maxVersion([]), null);
  assert.ok(compareVersions('6.10.1', '6.9.0') > 0);
  assert.equal(versionFromRcBranch('release-candidate/6.19.0'), '6.19.0');
  assert.equal(versionFromRcBranch('release-candidate/cryden1.8.0-traffico6.10.0'), null);
  assert.equal(versionFromRcBranch('feat/6.19.0'), null);
});

test('a candidate merged into the default branch counts as released before its tag exists', () => {
  const released = repoReleased({
    tags: [{ name: 'v1.14.0', at: '2026-11-09' }, { name: 'v1.13.0', at: '2026-11-02' }],
    mergedRc: [{ version: '1.15.0', at: '2026-11-10' }, { version: '1.14.0', at: '2026-11-09' }],
  });
  assert.deepEqual(released, { version: '1.15.0', source: 'merge', at: '2026-11-10' });
});

test('for the same version the tag is the evidence that is reported', () => {
  const released = repoReleased({ tags: [{ name: 'v6.18.0', at: 'tagged' }], mergedRc: [{ version: '6.18.0', at: 'merged' }] });
  assert.equal(released.source, 'tag');
  assert.equal(repoReleased({}), null);
});

test('a candidate is open while its version is above the product tag and this repository has not merged it', () => {
  const branches = [
    { name: 'release-candidate/1.15.0' },
    { name: 'release-candidate/1.16.0' },
    { name: 'release-candidate/1.14.0' },
    { name: 'main' },
  ];
  const portal = classifyRcBranches(branches, { productTagVersion: '1.14.0', mergedRcVersions: ['1.14.0'] });
  assert.deepEqual(portal.open.map((branch) => branch.version), ['1.15.0', '1.16.0']);
  assert.deepEqual(portal.leftovers.map((branch) => branch.version), ['1.14.0']);
  assert.equal(portal.latest.name, 'release-candidate/1.16.0');
});

test('a candidate this repository already merged is a leftover even when the tag is missing', () => {
  const api = classifyRcBranches([{ name: 'release-candidate/1.15.0' }], { productTagVersion: '1.14.0', mergedRcVersions: ['1.15.0'] });
  assert.deepEqual(api.open, []);
  assert.equal(api.latest, null);
  assert.deepEqual(api.leftovers.map((branch) => branch.version), ['1.15.0']);
});

test('product state is the union of what its repositories hold', () => {
  const repos = [
    { path: 'api', tags: [{ name: 'v1.14.0' }], released: { version: '1.15.0' }, rc: { open: [] } },
    { path: 'portal', tags: [{ name: 'v1.14.0' }], released: { version: '1.14.0' }, rc: { open: [{ version: '1.15.0' }, { version: '1.16.0' }] } },
  ];
  assert.equal(productTagVersion(repos.map((repo) => repo.tags)), '1.14.0');
  assert.deepEqual(productState(repos), { tagVersion: '1.14.0', released: '1.15.0', openVersions: ['1.15.0', '1.16.0'], latestOpen: '1.16.0' });
});
