/**
 * The cheap question asked between full rebuilds: did any merge request in the repositories on
 * the map change since the model was built? One request instead of a hundred.
 *
 * `newest` is the latest `updated_at` the last build saw, so both sides of the comparison are
 * GitLab's clock. A skewed local clock can neither hide a change nor keep reporting an old one.
 */

const projectPathOf = (mr) => String(mr.references?.full ?? '').replace(/!\d+$/, '');

/**
 * @param {{ get: (endpoint: string, query: object) => Promise<object[]> }} gitlab
 * @param {{ groupId: number|string, newest: string, watchedPaths: Iterable<string> }} input
 * @returns {Promise<boolean>} true when a watched repository has a merge request updated after `newest`
 */
export async function watchedChangeSince(gitlab, { groupId, newest, watchedPaths }) {
  if (!newest) return false;
  const watched = new Set(watchedPaths);
  // `updated_after` includes the boundary itself, hence the strict comparison below.
  const updated = await gitlab.get(`groups/${groupId}/merge_requests`, {
    scope: 'all',
    state: 'all',
    updated_after: newest,
    order_by: 'updated_at',
    sort: 'desc',
    per_page: 30,
  });
  return updated.some((mr) => mr.updated_at > newest && watched.has(projectPathOf(mr)));
}
