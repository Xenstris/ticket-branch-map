import assert from 'node:assert/strict';
import { test } from 'node:test';

import { watchedChangeSince } from '../lib/changes.mjs';

const mr = (project, iid, updatedAt) => ({ references: { full: `${project}!${iid}` }, updated_at: updatedAt });

function gitlabReturning(list) {
  const requests = [];
  return {
    requests,
    get: async (endpoint, query) => {
      requests.push({ endpoint, query });
      return list;
    },
  };
}

const input = { groupId: 9, newest: '2026-11-10T14:20:00.000Z', watchedPaths: ['g/cryden/cryden-portal', 'g/qa/tests'] };

test('a merge request updated after the last build in a watched repository is a change', async () => {
  const gitlab = gitlabReturning([mr('g/cryden/cryden-portal', 72, '2026-11-10T14:26:43.089Z')]);
  assert.equal(await watchedChangeSince(gitlab, input), true);
  assert.equal(gitlab.requests[0].endpoint, 'groups/9/merge_requests');
  assert.equal(gitlab.requests[0].query.updated_after, input.newest);
});

test('updates in repositories that are not on the map do not count', async () => {
  const gitlab = gitlabReturning([mr('g/other/marketerflow-app', 312, '2026-11-10T14:25:03.840Z')]);
  assert.equal(await watchedChangeSince(gitlab, input), false);
});

test('the merge request the last build already saw is not a change', async () => {
  // `updated_after` is inclusive, so GitLab returns the boundary merge request again.
  const gitlab = gitlabReturning([mr('g/cryden/cryden-portal', 72, input.newest)]);
  assert.equal(await watchedChangeSince(gitlab, input), false);
});

test('before the first build there is nothing to compare with, and nothing is asked', async () => {
  const gitlab = gitlabReturning([mr('g/cryden/cryden-portal', 72, '2026-11-10T14:26:43.089Z')]);
  assert.equal(await watchedChangeSince(gitlab, { ...input, newest: '' }), false);
  assert.equal(gitlab.requests.length, 0);
});
