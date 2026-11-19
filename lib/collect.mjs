/**
 * Builds the model the page renders: for every ticket, the branches and merge requests that
 * belong to it in every repository, what each came out of, where it points and where it should.
 *
 * Tickets come from the Notion snapshot; everything else is read live from GitLab (and, for the
 * QA repository, from its local checkout).
 */

import { GitLab } from './gitlab.mjs';
import { aheadBehind, readLocalRepo, subjectsNotIn } from './localgit.mjs';
import { branchMatchesTicket, matchMergeRequest, subjectMentionsTicket } from './match.mjs';
import { classifyRcBranches, productState, productTagVersion, repoReleased } from './release.mjs';
import {
  commits,
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
} from './relations.mjs';
import { RC_PREFIX, compareVersions, versionFromRcBranch } from './versions.mjs';

const STATUS_ORDER = [
  'In QA',
  'Ready for Test',
  'In Code Review',
  'In Progress',
  'Blocked',
  'Scheduled',
  'Not started',
  'Release Candidate',
];

const COUNT_CAP = 100;
const DAY = 86_400_000;
const LOCAL_BRANCH_MAX_AGE_DAYS = 120;
/** How far back a repository's merge requests are listed to match them by branch name. */
const RECENT_MR_DAYS = 120;
/** How long before a ticket existed its merge requests may have been opened. */
const SEARCH_BEFORE_TICKET_DAYS = 45;
const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const shortName = (repoPath) => repoPath.split('/').at(-1);
const itemKey = (repoPath, branch) => `${repoPath}#${branch}`;

// ---------------------------------------------------------------------------------------------
// GitLab reads

/** Which repositories ship together. The release train's own file wins over the local copy. */
async function resolveProducts(gl, gitlab, attempt) {
  const configured = gl.products;
  const train = gl.releaseTrain;
  if (!train) return configured;
  const live = await attempt(
    'release-train.json',
    () => gitlab.get(`projects/${GitLab.id(train.project)}/repository/files/${GitLab.id(train.file)}/raw`, { ref: train.ref }),
    null,
  );
  if (!Array.isArray(live?.products) || live.products.length === 0) return configured;
  return live.products.map((product) => ({
    name: product.name,
    label: configured.find((entry) => entry.name === product.name)?.label ?? capitalize(product.name),
    repos: product.repos,
  }));
}

async function scanRepo(gitlab, cache, { repoPath, role, product, environments, candidatePattern, listRecent }, attempt) {
  // Id, default branch and URL of a project practically never change; branches are read fresh.
  const projectKey = `project:${repoPath}`;
  let project = cache.get(projectKey, DAY);
  if (!project) {
    const full = await gitlab.get(`projects/${GitLab.id(repoPath)}`);
    project = {
      id: full.id,
      path_with_namespace: full.path_with_namespace,
      web_url: full.web_url,
      default_branch: full.default_branch,
    };
    cache.set(projectKey, project);
  }
  const base = `projects/${project.id}`;
  const name = shortName(project.path_with_namespace);
  const isProduct = role === 'product';

  const [branchList, recentMrs, tagList, mergedToDefault, deploymentList] = await Promise.all([
    gitlab.list(`${base}/repository/branches`, {}, { maxPages: 6 }),
    // The group search reads titles and descriptions only. A merge request named
    // "feat: dashboard suppressions created at" on branch feat/1265-... is found here instead.
    listRecent
      ? attempt(
          `${name}: ostatnie merge requesty`,
          () =>
            gitlab.list(
              `${base}/merge_requests`,
              {
                state: 'all',
                updated_after: new Date(Date.now() - RECENT_MR_DAYS * DAY).toISOString(),
                order_by: 'updated_at',
                sort: 'desc',
              },
              { maxPages: 4 },
            ),
          [],
        )
      : [],
    isProduct
      ? attempt(`${name}: tagi`, () => gitlab.get(`${base}/repository/tags`, { order_by: 'version', sort: 'desc', per_page: 20 }), [])
      : [],
    isProduct
      ? attempt(
          `${name}: scalone wydania`,
          () =>
            gitlab.get(`${base}/merge_requests`, {
              state: 'merged',
              target_branch: project.default_branch,
              order_by: 'updated_at',
              sort: 'desc',
              per_page: 40,
            }),
          [],
        )
      : [],
    isProduct
      ? Promise.all(
          environments.map((environment) =>
            attempt(
              `${name}: wdrożenia ${environment}`,
              () =>
                gitlab.get(`${base}/deployments`, {
                  environment,
                  status: 'success',
                  order_by: 'finished_at',
                  sort: 'desc',
                  per_page: 1,
                }),
              [],
            ).then((list) => [environment, list[0] ?? null]),
          ),
        )
      : [],
  ]);

  const branches = {};
  for (const branch of branchList) {
    branches[branch.name] = {
      name: branch.name,
      sha: branch.commit?.id ?? null,
      committedAt: branch.commit?.committed_date ?? null,
      merged: Boolean(branch.merged),
    };
  }

  const candidates = candidatePattern
    ? Object.values(branches)
        .filter((branch) => candidatePattern.test(branch.name))
        .sort((a, b) => String(a.committedAt).localeCompare(String(b.committedAt)))
        .map((branch) => branch.name)
    : [];

  const deployments = {};
  for (const [environment, deployment] of deploymentList) {
    if (!deployment) continue;
    const mrIid = /^refs\/merge-requests\/(\d+)\/head$/.exec(deployment.ref ?? '')?.[1];
    deployments[environment] = {
      environment,
      ref: deployment.ref,
      sha: deployment.sha,
      at: deployment.deployable?.finished_at ?? deployment.updated_at ?? null,
      by: deployment.user?.name ?? deployment.user?.username ?? null,
      mrIid: mrIid ? Number(mrIid) : null,
      mr: null,
    };
  }

  return {
    id: project.id,
    path: project.path_with_namespace,
    name,
    webUrl: project.web_url,
    defaultBranch: project.default_branch,
    role,
    product,
    branches,
    candidates,
    recentMrs,
    tags: tagList.map((tag) => ({ name: tag.name, at: tag.commit?.committed_date ?? null })),
    mergedRc: mergedToDefault
      .filter((mr) => mr.source_branch?.startsWith(RC_PREFIX) && versionFromRcBranch(mr.source_branch))
      .map((mr) => ({ version: versionFromRcBranch(mr.source_branch), at: mr.merged_at, iid: mr.iid })),
    deployments,
    rc: { open: [], leftovers: [], latest: null },
    rcChain: null,
    released: null,
  };
}

/** Commits reachable from `to` but not from `from`, counted up to `COUNT_CAP`. */
async function countCommits(gitlab, cache, projectId, from, to) {
  if (from === to) return { count: 0, capped: false };
  const key = `cmp:${projectId}:${from}..${to}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const list = await gitlab.get(`projects/${projectId}/repository/commits`, { ref_name: `${from}..${to}`, per_page: COUNT_CAP });
  const value = { count: list.length, capped: list.length >= COUNT_CAP };
  cache.set(key, value);
  return value;
}

/** Like `countCommits`, keeping who wrote what: needed to tell a missing commit from a rebased copy. */
async function rangeCommits(gitlab, cache, projectId, from, to) {
  if (from === to) return { count: 0, capped: false, commits: [] };
  const key = `log:${projectId}:${from}..${to}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const list = await gitlab.get(`projects/${projectId}/repository/commits`, { ref_name: `${from}..${to}`, per_page: COUNT_CAP });
  const value = {
    count: list.length,
    capped: list.length >= COUNT_CAP,
    commits: list.map((commit) => ({
      id: commit.short_id ?? String(commit.id ?? '').slice(0, 8),
      title: commit.title ?? '',
      author: commit.author_name ?? '',
      at: commit.committed_date ?? commit.created_at ?? null,
    })),
  };
  cache.set(key, value);
  return value;
}

/** Two commits hold the same files when their top-level trees list the same object ids. */
async function sameTree(gitlab, cache, projectId, left, right) {
  if (left === right) return true;
  const listing = async (sha) => {
    const key = `tree:${projectId}:${sha}`;
    let value = cache.get(key);
    if (value === undefined) {
      const entries = await gitlab.list(`projects/${projectId}/repository/tree`, { ref: sha }, { maxPages: 3 });
      value = entries.map((entry) => `${entry.mode} ${entry.id} ${entry.name}`).sort().join('\n');
      cache.set(key, value);
    }
    return value;
  };
  const [a, b] = await Promise.all([listing(left), listing(right)]);
  return a === b;
}

/**
 * How a repository's candidates sit on each other: default branch, then the open candidates from
 * the oldest to the newest. For every link the question is whether the later branch contains
 * everything the earlier one has (it was rebased after the earlier one moved), and for every
 * candidate whether the default branch already has what it carries.
 */
async function buildRcChain(repo, gitlab, cache, attempt) {
  const defaultHead = repo.branches[repo.defaultBranch]?.sha ?? null;
  const branchUrl = (name) => `${repo.webUrl}/-/tree/${name.split('/').map(encodeURIComponent).join('/')}`;
  const compareUrl = (from, to) => `${repo.webUrl}/-/compare/${encodeURIComponent(from)}...${encodeURIComponent(to)}`;

  const against = async (candidate, baseName) => {
    const head = repo.branches[candidate.name]?.sha;
    const base = repo.branches[baseName]?.sha;
    if (!head || !base) return null;
    const [ahead, behind] = await Promise.all([
      rangeCommits(gitlab, cache, repo.id, base, head),
      rangeCommits(gitlab, cache, repo.id, head, base),
    ]);
    const relation = containment({ ahead, behind });
    return { base: baseName, baseLabel: refLabel(baseName), compareUrl: compareUrl(baseName, candidate.name), ...relation, ...containmentText(relation, refLabel(baseName)) };
  };

  const describe = async (candidate, previous, isLeftover) => {
    const head = repo.branches[candidate.name]?.sha ?? null;
    const [toDefault, toPrevious] = await Promise.all([against(candidate, repo.defaultBranch), previous ? against(candidate, previous.name) : null]);
    const sameContent =
      toDefault && toDefault.ahead > 0 && head && defaultHead
        ? await attempt(`${repo.name}: porównanie treści ${candidate.name}`, () => sameTree(gitlab, cache, repo.id, head, defaultHead), null)
        : null;
    const released = Boolean(repo.released && compareVersions(candidate.version, repo.released.version) <= 0);
    return {
      name: candidate.name,
      version: candidate.version,
      label: refLabel(candidate.name),
      webUrl: branchUrl(candidate.name),
      committedAt: repo.branches[candidate.name]?.committedAt ?? null,
      latest: repo.rc.latest?.name === candidate.name,
      leftover: isLeftover,
      released,
      toDefault,
      toPrevious,
      sameContentAsDefault: sameContent,
      unreleased: toDefault
        ? unreleasedText({ ahead: toDefault.ahead, aheadCapped: toDefault.aheadCapped, sameContent, released: released || isLeftover, defaultBranch: repo.defaultBranch })
        : null,
    };
  };

  const open = await Promise.all(
    repo.rc.open.map((candidate, index) =>
      attempt(`${repo.name}: stan ${candidate.name}`, () => describe(candidate, repo.rc.open[index - 1] ?? null, false), null),
    ),
  );
  const leftovers = await Promise.all(
    repo.rc.leftovers.map((candidate) => attempt(`${repo.name}: stan ${candidate.name}`, () => describe(candidate, null, true), null)),
  );
  return { defaultBranch: repo.defaultBranch, defaultUrl: branchUrl(repo.defaultBranch), open: open.filter(Boolean), leftovers: leftovers.filter(Boolean) };
}

const shapeMr = (mr) => ({
  iid: mr.iid,
  title: mr.title,
  state: mr.state,
  draft: Boolean(mr.draft ?? mr.work_in_progress),
  webUrl: mr.web_url,
  author: { username: mr.author?.username ?? null, name: mr.author?.name ?? mr.author?.username ?? null },
  createdAt: mr.created_at,
  updatedAt: mr.updated_at,
  mergedAt: mr.merged_at ?? null,
  closedAt: mr.closed_at ?? null,
  targetRef: mr.target_branch,
  sha: mr.sha ?? null,
  hasConflicts: Boolean(mr.has_conflicts),
  mergeStatus: mr.detailed_merge_status ?? null,
  discussionsResolved: mr.blocking_discussions_resolved ?? null,
  behindTarget: null,
  pipeline: null,
});

const mrRank = (mr) => (mr.state === 'opened' ? 0 : mr.state === 'merged' ? 1 : 2);
const byRecency = (a, b) =>
  mrRank(a) - mrRank(b) || String(b.merged_at ?? b.updated_at).localeCompare(String(a.merged_at ?? a.updated_at));

// ---------------------------------------------------------------------------------------------
// The model

/**
 * @param {{
 *   config: object, snapshot: object, gitlab: GitLab,
 *   cache: { get: Function, set: Function }, onProgress?: (text: string) => void,
 * }} input
 */
export async function buildModel({ config, snapshot, gitlab, cache, onProgress = () => {} }) {
  const startedAt = Date.now();
  const callsBefore = gitlab.calls;
  const gl = config.gitlab;
  const warnings = [...(snapshot.warnings ?? [])];
  const attempt = async (label, fn, fallback) => {
    try {
      return await fn();
    } catch (error) {
      warnings.push(`${label}: ${error.message}`);
      return fallback;
    }
  };

  // --- which repositories, in which role -----------------------------------------------------
  onProgress('GitLab: czytam konfigurację wydań');
  const productDefs = await resolveProducts(gl, gitlab, attempt);
  const productOfRepo = new Map(productDefs.flatMap((product) => product.repos.map((repoPath) => [repoPath, product.name])));
  const candidatePattern = gl.qa?.candidateBranch ? new RegExp(gl.qa.candidateBranch) : null;
  const describeRepo = (repoPath) => {
    if (productOfRepo.has(repoPath)) return { role: 'product', product: productOfRepo.get(repoPath) };
    if (repoPath === gl.qa?.project) return { role: 'qa', product: null };
    if (gl.libraries?.[repoPath]) return { role: 'library', product: gl.libraries[repoPath] };
    return { role: 'other', product: null };
  };

  const repoScans = new Map();
  const scan = (repoPath) => {
    if (!repoScans.has(repoPath)) {
      const { role, product } = describeRepo(repoPath);
      repoScans.set(
        repoPath,
        attempt(
          `Repozytorium ${repoPath}`,
          () =>
            scanRepo(
              gitlab,
              cache,
              {
                repoPath,
                role,
                product,
                environments: gl.environments ?? [],
                candidatePattern: role === 'qa' ? candidatePattern : null,
                listRecent: role === 'product' || role === 'qa',
              },
              attempt,
            ),
          null,
        ),
      );
    }
    return repoScans.get(repoPath);
  };
  for (const product of productDefs) product.repos.forEach(scan);
  if (gl.qa?.project) scan(gl.qa.project);

  // --- tickets and the numbers that lead to their merge requests -----------------------------
  const tickets = snapshot.tickets ?? [];
  const ticketByPage = new Map(tickets.map((ticket) => [ticket.pageId, ticket]));
  const lookup = (pageId) => ticketByPage.get(pageId) ?? snapshot.related?.[pageId] ?? null;

  const sourcesOf = (ticket) => {
    const sources = [{ via: 'own', number: ticket.number, pageId: ticket.pageId, createdAt: ticket.createdAt, title: ticket.title }];
    for (const alias of config.tickets?.aliases?.[ticket.number] ?? []) {
      sources.push({ via: 'alias', number: Number(alias), pageId: null, createdAt: null, title: null });
    }
    for (const [via, ids] of [
      ['parent', ticket.parentIds],
      ['subtask', ticket.subtaskIds],
    ]) {
      for (const id of ids) {
        const other = lookup(id);
        if (other?.number) {
          sources.push({ via, number: other.number, pageId: other.pageId, createdAt: other.createdAt ?? null, title: other.title });
        }
      }
    }
    return sources;
  };
  const ticketSources = new Map(tickets.map((ticket) => [ticket.number, sourcesOf(ticket)]));
  const allSources = [...ticketSources.values()].flat();
  const numbers = [...new Set(allSources.map((source) => source.number))];
  /** number -> earliest creation date worth searching from, or null when unknown for any use of it */
  const searchFrom = new Map();
  for (const number of numbers) {
    const dates = allSources.filter((source) => source.number === number).map((source) => source.createdAt);
    searchFrom.set(
      number,
      dates.every(Boolean)
        ? new Date(Math.min(...dates.map((date) => Date.parse(date))) - SEARCH_BEFORE_TICKET_DAYS * DAY).toISOString()
        : null,
    );
  }

  onProgress(`GitLab: ${repoScans.size} repozytoriów i merge requesty dla ${numbers.length} numerów`);
  const searchResults = new Map();
  await Promise.all(
    numbers.map(async (number) => {
      searchResults.set(
        number,
        await attempt(
          `Szukanie MR-ów dla ${number}`,
          () =>
            gitlab.list(
              `groups/${gl.groupId}/merge_requests`,
              {
                scope: 'all',
                state: 'all',
                search: String(number),
                // Without a lower bound a short number matches years of unrelated merge requests.
                created_after: searchFrom.get(number) ?? undefined,
                order_by: 'updated_at',
                sort: 'desc',
              },
              { maxPages: 3 },
            ),
          [],
        ),
      );
    }),
  );

  // --- match merge requests to tickets; scan the repositories that turned up -----------------
  const firstScans = (await Promise.all([...repoScans.values()])).filter(Boolean);
  const recent = firstScans.flatMap((repo) => repo.recentMrs.map((mr) => ({ mr, repoPath: repo.path })));
  const repoPathOf = (mr) => String(mr.references?.full ?? '').replace(/!\d+$/, '');
  /** A release merge (candidate -> default branch) mentions every ticket it ships and belongs to none. */
  const isReleaseMerge = (mr) => mr.source_branch?.startsWith(RC_PREFIX) || Boolean(candidatePattern?.test(mr.source_branch ?? ''));

  /** ticket number -> [{ mr, source, strength, repoPath }] */
  const matches = new Map();
  for (const ticket of tickets) {
    const seen = new Set();
    const list = [];
    for (const source of ticketSources.get(ticket.number)) {
      const candidates = [
        ...(searchResults.get(source.number) ?? []).map((mr) => ({ mr, repoPath: repoPathOf(mr) })),
        ...recent,
      ];
      for (const { mr, repoPath } of candidates) {
        if (seen.has(mr.id) || !repoPath || isReleaseMerge(mr)) continue;
        const strength = matchMergeRequest(mr, source);
        if (!strength) continue;
        seen.add(mr.id);
        list.push({ mr, source, strength, repoPath });
        scan(repoPath);
      }
    }
    matches.set(ticket.number, list);
  }

  const repos = new Map();
  for (const [repoPath, promise] of repoScans) {
    const state = await promise;
    if (state) repos.set(state.path, state);
    if (state && state.path !== repoPath) repos.set(repoPath, state);
  }

  // --- release state per product ---------------------------------------------------------------
  const products = productDefs.map((definition) => {
    const members = definition.repos.map((repoPath) => repos.get(repoPath)).filter(Boolean);
    const tagVersion = productTagVersion(members.map((repo) => repo.tags));
    for (const repo of members) {
      repo.rc = classifyRcBranches(Object.values(repo.branches), {
        productTagVersion: tagVersion,
        mergedRcVersions: repo.mergedRc.map((entry) => entry.version),
      });
      repo.released = repoReleased({ tags: repo.tags, mergedRc: repo.mergedRc });
    }
    return { name: definition.name, label: definition.label, repos: members.map((repo) => repo.path), ...productState(members) };
  });
  const productByName = new Map(products.map((product) => [product.name, product]));

  // --- do the candidates contain each other and the default branch -----------------------------
  onProgress('GitLab: porównuję gałęzie RC między sobą i z gałęzią domyślną');
  await Promise.all(
    [...new Set(repos.values())]
      .filter((repo) => repo.role === 'product')
      .map(async (repo) => {
        repo.rcChain = await buildRcChain(repo, gitlab, cache, attempt);
      }),
  );

  // --- what is deployed where: name the merge request behind each deployment ------------------
  await Promise.all(
    [...new Set(repos.values())].flatMap((repo) =>
      Object.values(repo.deployments)
        .filter((deployment) => deployment.mrIid)
        .map(async (deployment) => {
          const key = `mr:${repo.id}!${deployment.mrIid}`;
          let info = cache.get(key, DAY);
          if (info === undefined) {
            const mr = await attempt(
              `${repo.name}: MR !${deployment.mrIid}`,
              () => gitlab.get(`projects/${repo.id}/merge_requests/${deployment.mrIid}`),
              null,
            );
            info = mr ? { sourceBranch: mr.source_branch, title: mr.title, webUrl: mr.web_url, state: mr.state } : null;
            if (info) cache.set(key, info);
          }
          deployment.mr = info ?? null;
        }),
    ),
  );

  // --- local checkout of the QA repository -----------------------------------------------------
  const qaRepo = gl.qa?.project ? repos.get(gl.qa.project) : null;
  const local = qaRepo ? await readLocalRepo(gl.qa.localPath) : null;
  const localByName = new Map((local?.branches ?? []).map((branch) => [branch.name, branch]));
  const localSubjects = new Map();
  if (local && qaRepo) {
    const recent = local.branches.filter(
      (branch) =>
        branch.name !== qaRepo.defaultBranch &&
        Date.now() - new Date(branch.committedAt).getTime() < LOCAL_BRANCH_MAX_AGE_DAYS * DAY,
    );
    await Promise.all(
      recent.map(async (branch) => {
        localSubjects.set(branch.name, await subjectsNotIn(local.path, branch.name, `origin/${qaRepo.defaultBranch}`));
      }),
    );
  }

  // --- items: one per (repository, branch) of a ticket -----------------------------------------
  onProgress('GitLab: szczegóły merge requestów i relacje między gałęziami');
  const builtTickets = await Promise.all(
    tickets.map((ticket) =>
      buildTicket({
        ticket,
        sources: ticketSources.get(ticket.number),
        matched: matches.get(ticket.number),
        repos,
        productByName,
        productDefs,
        qaRepo,
        local,
        localByName,
        localSubjects,
        ignoreLocal: gl.qa?.ignoreLocalBranches ? new RegExp(gl.qa.ignoreLocalBranches) : null,
        gitlab,
        cache,
        attempt,
        snapshot,
        lookup,
      }),
    ),
  );

  builtTickets.sort(
    (a, b) =>
      (STATUS_ORDER.indexOf(a.status) + 1 || 99) - (STATUS_ORDER.indexOf(b.status) + 1 || 99) ||
      String(b.editedAt).localeCompare(String(a.editedAt)),
  );

  const uniqueRepos = [...new Set(repos.values())];
  return {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    gitlabCalls: gitlab.calls - callsBefore,
    notion: { fetchedAt: snapshot.fetchedAt ?? null, me: snapshot.me ?? null },
    // GitLab's own clock: the server asks for anything updated after this to notice changes early.
    newestMergeRequestUpdate: recent.reduce((newest, { mr }) => (mr.updated_at > newest ? mr.updated_at : newest), ''),
    statusOrder: STATUS_ORDER,
    products,
    repos: uniqueRepos.map((repo) => ({
      path: repo.path,
      name: repo.name,
      webUrl: repo.webUrl,
      role: repo.role,
      product: repo.product,
      defaultBranch: repo.defaultBranch,
      released: repo.released,
      rcOpen: repo.rc.open.map(({ name, version, sha, committedAt }) => ({ name, version, sha, committedAt })),
      rcLeftovers: repo.rc.leftovers.map(({ name, version, committedAt }) => ({ name, version, committedAt })),
      candidates: repo.candidates,
      deployments: repo.deployments,
      rcChain: repo.rcChain,
    })),
    tickets: builtTickets,
    warnings: [...new Set(warnings)].slice(0, 30),
  };
}

async function buildTicket(context) {
  const {
    ticket,
    sources,
    matched,
    repos,
    productByName,
    productDefs,
    qaRepo,
    local,
    localByName,
    localSubjects,
    ignoreLocal,
    gitlab,
    cache,
    attempt,
    snapshot,
    lookup,
  } = context;

  // Group merge requests by repository and source branch.
  /** key -> { repo, branch, via, strength, mrs: [] } */
  const groups = new Map();
  const group = (repo, branch, source, strength) => {
    const key = itemKey(repo.path, branch);
    if (!groups.has(key)) groups.set(key, { key, repo, branch, via: source, strength, mrs: [] });
    return groups.get(key);
  };

  for (const { mr, source, strength, repoPath } of matched) {
    const repo = repos.get(repoPath);
    if (!repo) continue;
    // A parent ticket usually spans products; a sub-task shows only the part it is about.
    if (source.via === 'parent' && ticket.products.length && repo.product && !ticket.products.includes(repo.product)) continue;
    group(repo, mr.source_branch, source, strength).mrs.push(mr);
  }

  // The search reads titles and descriptions, so a branch can carry the ticket's number while
  // its merge request does not mention it. Ask GitLab for the merge requests of such a branch.
  const lookups = [];
  const lookUpMergeRequests = (entry) =>
    attempt(
      `${entry.repo.name}: MR-y gałęzi ${entry.branch}`,
      () =>
        gitlab.get(`projects/${entry.repo.id}/merge_requests`, {
          source_branch: entry.branch,
          state: 'all',
          order_by: 'updated_at',
          sort: 'desc',
          per_page: 5,
        }),
      [],
    ).then((list) => entry.mrs.push(...list));

  for (const repo of new Set(repos.values())) {
    for (const branch of Object.values(repo.branches)) {
      const source = sources.find((entry) => entry.via !== 'parent' && branchMatchesTicket(branch.name, entry.number));
      if (!source || groups.has(itemKey(repo.path, branch.name))) continue;
      if (branch.name === repo.defaultBranch || branch.name.startsWith(RC_PREFIX)) continue;
      lookups.push(lookUpMergeRequests(group(repo, branch.name, source, 'branch')));
    }
  }

  // Local branches of the QA repository: named after the ticket, or carrying its commits. This
  // is the only way to see work that has not been pushed yet.
  if (qaRepo && local) {
    const own = sources.filter((entry) => entry.via === 'own' || entry.via === 'alias');
    for (const branch of local.branches) {
      if (groups.has(itemKey(qaRepo.path, branch.name))) continue;
      if (branch.upstreamGone || branch.name === qaRepo.defaultBranch || ignoreLocal?.test(branch.name)) continue;
      const source = own.find(
        (entry) =>
          branchMatchesTicket(branch.name, entry.number) ||
          (localSubjects.get(branch.name) ?? []).some((subject) => subjectMentionsTicket(subject, entry.number)),
      );
      if (!source) continue;
      const entry = group(qaRepo, branch.name, source, 'local');
      if (qaRepo.branches[branch.name]) lookups.push(lookUpMergeRequests(entry));
    }
  }
  await Promise.all(lookups);

  const items = await Promise.all(
    [...groups.values()].map((entry) => buildItem({ entry, productByName, local, localByName, qaRepo, gitlab, cache, attempt })),
  );

  // Stack links: a branch whose merge request targets another branch of the same ticket.
  const byKey = new Map(items.map((item) => [item.key, item]));
  for (const item of items) {
    const parent = item.mr ? byKey.get(itemKey(item.repo, item.mr.targetRef)) : null;
    item.parentKey = parent && parent.key !== item.key ? parent.key : null;
  }

  // Lanes, grouped the way the page shows them.
  const lanesByRepo = new Map();
  for (const item of items) {
    if (!lanesByRepo.has(item.repo)) lanesByRepo.set(item.repo, []);
    lanesByRepo.get(item.repo).push(item);
  }
  const laneOf = (repo) => {
    const laneItems = (lanesByRepo.get(repo.path) ?? []).sort(
      (a, b) =>
        (a.mr ? mrRank(a.mr) : 0) - (b.mr ? mrRank(b.mr) : 0) ||
        String(b.mr?.mergedAt ?? b.mr?.updatedAt ?? b.committedAt).localeCompare(String(a.mr?.mergedAt ?? a.mr?.updatedAt ?? a.committedAt)),
    );
    return {
      repo: repo.path,
      name: repo.name,
      webUrl: repo.webUrl,
      role: repo.role,
      defaultBranch: repo.defaultBranch,
      released: repo.released,
      deployments: Object.values(repo.deployments).map((deployment) => {
        const item = laneItems.find((entry) => (deployment.mrIid && entry.mr?.iid === deployment.mrIid) || deployment.ref === entry.branch);
        return { ...deployment, item: item?.key ?? null, upToDate: item ? deployment.sha === item.sha : null };
      }),
      trunks: laneTrunks(repo, laneItems, productByName.get(repo.product)),
      items: laneItems,
    };
  };

  const used = new Set(lanesByRepo.keys());
  const laneGroups = [];
  if (qaRepo && used.has(qaRepo.path)) laneGroups.push({ key: 'qa', label: 'Testy QA', lanes: [laneOf(qaRepo)] });
  for (const definition of productDefs) {
    const product = productByName.get(definition.name);
    const members = [...new Set(repos.values())].filter(
      (repo) => repo.product === definition.name && used.has(repo.path) && repo.role !== 'qa',
    );
    if (members.length === 0) continue;
    members.sort((a, b) => Number(b.role === 'product') - Number(a.role === 'product') || definition.repos.indexOf(a.path) - definition.repos.indexOf(b.path));
    laneGroups.push({
      key: definition.name,
      label: definition.label,
      released: product?.released ?? null,
      openVersions: product?.openVersions ?? [],
      lanes: members.map(laneOf),
    });
  }
  const rest = [...new Set(repos.values())].filter((repo) => used.has(repo.path) && !repo.product && repo.role !== 'qa');
  if (rest.length) laneGroups.push({ key: 'other', label: 'Wspólne biblioteki i inne', lanes: rest.map(laneOf) });

  // Ticket-level findings.
  const releaseVersions = ticket.releaseVersionIds.map((id) => snapshot.releaseVersions?.[id] ?? { name: null, product: null, version: null, url: null });
  const problems = [];
  for (const item of items) {
    const repo = repos.get(item.repo);
    for (const flag of item.flags) {
      problems.push({ ...flag, repoName: repo.name, mrIid: item.mr?.iid ?? null, branch: item.branch, itemKey: item.key });
    }
  }
  for (const definition of productDefs) {
    const entries = items
      .filter((item) => item.mr?.state === 'opened' && !item.parentKey && item.target && item.target.kind !== 'branch')
      .map((item) => ({ item, repo: repos.get(item.repo) }))
      .filter(({ repo }) => repo.role === 'product' && repo.product === definition.name)
      .map(({ item, repo }) => ({ repoName: repo.name, target: item.target }));
    const mismatch = productTargetMismatch({ productLabel: definition.label, entries });
    if (mismatch) problems.push({ ...mismatch, repoName: null, mrIid: null, branch: null, itemKey: null });

    const planned = releaseVersions.find((version) => version.product === definition.name && version.version);
    const product = productByName.get(definition.name);
    if (planned && entries.length) {
      const released = product?.released && compareVersions(planned.version, product.released) <= 0;
      const offTarget = entries.filter((entry) => !(entry.target.kind === 'rc' && entry.target.version === planned.version));
      if (released) {
        problems.push({
          level: 'info',
          code: 'notion-version-released',
          text: `Notion planuje ten ticket na ${definition.label} ${planned.version}, a ta wersja jest już wydana; otwarte MR-y wyjdą w kolejnej`,
          repoName: null,
          mrIid: null,
          branch: null,
          itemKey: null,
        });
      } else if (offTarget.length) {
        problems.push({
          level: 'info',
          code: 'notion-version-differs',
          text: `Notion planuje ten ticket na ${definition.label} ${planned.version}; inaczej celują: ${offTarget.map((entry) => `${entry.repoName} → ${entry.target.label}`).join(', ')}`,
          repoName: null,
          mrIid: null,
          branch: null,
          itemKey: null,
        });
      }
    }
  }

  const iAmQa = Boolean(snapshot.me && ticket.qaAssigneeIds.includes(snapshot.me.id));
  if (iAmQa && qaRepo && items.length > 0 && !items.some((item) => item.repo === qaRepo.path && item.via.type !== 'parent')) {
    problems.push({
      level: 'info',
      code: 'no-qa-branch',
      text: `W ${qaRepo.name} nie ma jeszcze gałęzi testów dla tego ticketu`,
      repoName: null,
      mrIid: null,
      branch: null,
      itemKey: null,
    });
  }

  const openItems = items.filter((item) => item.mr?.state === 'opened');
  const mergedItems = items.filter((item) => item.mr?.state === 'merged');
  if (items.length === 0) {
    problems.push({
      level: 'info',
      code: 'nothing-found',
      text: `Nie ma jeszcze żadnej gałęzi ani merge requesta z numerem ${ticket.number}`,
      repoName: null,
      mrIid: null,
      branch: null,
      itemKey: null,
    });
  } else if (openItems.length === 0 && items.every((item) => item.mr) && mergedItems.every((item) => item.outcome?.type !== 'in-rc')) {
    problems.push({
      level: 'info',
      code: 'all-merged',
      text: `Wszystkie merge requesty są scalone i nic nie czeka w otwartym RC, a status w Notion to „${ticket.status}”`,
      repoName: null,
      mrIid: null,
      branch: null,
      itemKey: null,
    });
  }
  const order = { error: 0, warn: 1, info: 2 };
  problems.sort((a, b) => order[a.level] - order[b.level]);

  const person = (id) => ({ id, name: snapshot.users?.[id] ?? null });
  const relatedTicket = (id) => {
    const other = lookup(id);
    return other ? { number: other.number, title: other.title, status: other.status, url: other.url } : null;
  };

  return {
    number: ticket.number,
    title: ticket.title,
    url: ticket.url,
    status: ticket.status,
    qaAutomated: ticket.qaAutomated,
    priority: ticket.priority,
    flag: ticket.flag,
    types: ticket.types,
    products: ticket.products,
    assignees: ticket.assigneeIds.map(person),
    qaAssignees: ticket.qaAssigneeIds.map(person),
    roles: [
      ...(snapshot.me && ticket.qaAssigneeIds.includes(snapshot.me.id) ? ['qa'] : []),
      ...(snapshot.me && ticket.assigneeIds.includes(snapshot.me.id) ? ['dev'] : []),
    ],
    createdAt: ticket.createdAt,
    editedAt: ticket.editedAt,
    releaseVersions,
    parents: ticket.parentIds.map(relatedTicket).filter(Boolean),
    subtasks: ticket.subtaskIds.map(relatedTicket).filter(Boolean),
    groups: laneGroups,
    problems,
    counts: {
      items: items.length,
      open: openItems.length,
      merged: mergedItems.length,
      errors: problems.filter((problem) => problem.level === 'error').length,
      warnings: problems.filter((problem) => problem.level === 'warn').length,
    },
  };
}

async function buildItem({ entry, productByName, local, localByName, qaRepo, gitlab, cache, attempt }) {
  const { repo, branch } = entry;
  const mrs = [...new Map(entry.mrs.map((mr) => [mr.id, mr])).values()].sort(byRecency);
  const primary = mrs[0] ?? null;
  const remote = repo.branches[branch] ?? null;

  const item = {
    key: entry.key,
    repo: repo.path,
    branch,
    branchUrl: remote ? `${repo.webUrl}/-/tree/${branch.split('/').map(encodeURIComponent).join('/')}` : null,
    via: { type: entry.via.via, number: entry.via.number, title: entry.via.via === 'own' ? null : entry.via.title },
    matchedBy: entry.strength,
    exists: Boolean(remote),
    sha: remote?.sha ?? primary?.sha ?? null,
    committedAt: remote?.committedAt ?? null,
    mr: primary ? shapeMr(primary) : null,
    otherMrs: mrs.slice(1).map((mr) => ({ iid: mr.iid, state: mr.state, targetRef: mr.target_branch, webUrl: mr.web_url, title: mr.title })),
    target: null,
    expected: null,
    relations: [],
    base: null,
    outcome: null,
    local: null,
    flags: [],
    parentKey: null,
  };

  const isOpen = item.mr?.state === 'opened';
  const isLive = isOpen || !item.mr;
  if (item.mr) item.target = describeRef(item.mr.targetRef, repo);

  if (isOpen) {
    const detail = await attempt(
      `${repo.name} !${item.mr.iid}`,
      () => gitlab.get(`projects/${repo.id}/merge_requests/${item.mr.iid}`, { include_diverged_commits_count: true }),
      null,
    );
    if (detail) {
      Object.assign(item.mr, shapeMr(detail), {
        behindTarget: detail.diverged_commits_count ?? null,
        pipeline: detail.head_pipeline ? { status: detail.head_pipeline.status, webUrl: detail.head_pipeline.web_url } : null,
      });
      item.target = describeRef(item.mr.targetRef, repo);
    }
  }

  if (isLive) {
    item.expected = expectedTarget({
      target: item.target,
      repo,
      productLatestOpen: productByName.get(repo.product)?.latestOpen ?? null,
    });
  }

  // How far the branch is from every branch it could have come out of or could be merged into.
  if (isLive && remote?.sha) {
    const candidates = new Set([repo.defaultBranch, ...repo.rc.open.map((rc) => rc.name), ...repo.candidates]);
    if (item.target?.exists) candidates.add(item.target.ref);
    candidates.delete(branch);
    item.relations = (
      await Promise.all(
        [...candidates].map(async (ref) => {
          const other = repo.branches[ref];
          if (!other?.sha) return null;
          const counted = await attempt(
            `${repo.name}: ${branch} względem ${ref}`,
            async () => {
              const [ahead, behind] = await Promise.all([
                countCommits(gitlab, cache, repo.id, other.sha, remote.sha),
                countCommits(gitlab, cache, repo.id, remote.sha, other.sha),
              ]);
              return { ahead, behind };
            },
            null,
          );
          if (!counted) return null;
          const described = describeRef(ref, repo);
          return {
            ref,
            label: described.label,
            kind: described.kind,
            version: described.version,
            ahead: counted.ahead.count,
            aheadCapped: counted.ahead.capped,
            behind: counted.behind.count,
            behindCapped: counted.behind.capped,
            isTarget: item.target?.ref === ref,
            isExpected: item.expected?.ref === ref,
          };
        }),
      )
    ).filter(Boolean);
    item.base = pickBase(item.relations, item.target?.ref ?? null);
    if (item.base) item.relations.find((relation) => relation.ref === item.base.ref).isBase = true;
  }

  // Local checkout (QA repository only).
  if (local && qaRepo && repo.path === qaRepo.path) {
    const mine = localByName.get(branch);
    if (mine) {
      const info = { current: local.current === branch, dirty: local.current === branch ? local.dirty : 0, state: 'synced', ahead: 0, behind: 0 };
      if (!remote) {
        info.state = item.mr ? 'remote-gone' : 'local-only';
        const counted = await aheadBehind(local.path, mine.sha, `origin/${repo.defaultBranch}`);
        if (counted && !item.mr) {
          item.relations = [
            {
              ref: repo.defaultBranch,
              label: repo.defaultBranch,
              kind: 'default',
              version: null,
              ahead: counted.ahead,
              aheadCapped: false,
              behind: counted.behind,
              behindCapped: false,
              isTarget: false,
              isExpected: item.expected?.ref === repo.defaultBranch,
              isBase: true,
              fromLocalRefs: true,
            },
          ];
          item.base = item.relations[0];
        }
        item.sha = item.sha ?? mine.sha;
        item.committedAt = item.committedAt ?? mine.committedAt;
      } else if (mine.sha !== remote.sha) {
        const counted = await aheadBehind(local.path, mine.sha, remote.sha);
        if (!counted) info.state = 'unknown';
        else {
          info.ahead = counted.ahead;
          info.behind = counted.behind;
          info.state = counted.ahead && counted.behind ? 'diverged' : counted.ahead ? 'ahead' : 'behind';
        }
      }
      item.local = info;
    }
  }

  // Findings.
  if (isOpen && item.target && item.expected) {
    item.flags = openItemFlags({
      mr: {
        hasConflicts: item.mr.hasConflicts,
        behindTarget: item.mr.behindTarget,
        pipelineStatus: item.mr.pipeline?.status ?? null,
        discussionsResolved: item.mr.discussionsResolved,
      },
      target: item.target,
      expected: item.expected,
      relations: item.relations,
      base: item.base,
      repo,
    });
  } else if (!item.mr) {
    item.flags = [
      {
        level: 'info',
        code: 'no-mr',
        text:
          item.local?.state === 'local-only'
            ? `gałąź istnieje tylko lokalnie; gdy powstanie MR, powinien celować w ${refLabel(item.expected.ref)}`
            : `gałąź bez merge requesta; MR powinien celować w ${refLabel(item.expected.ref)}`,
      },
    ];
  } else if (item.mr.state === 'merged') {
    item.outcome = mergedOutcome({ target: item.target, repo });
  }

  if (item.local?.state === 'ahead' || item.local?.state === 'diverged') {
    item.flags.push({ level: 'info', code: 'local-ahead', text: `lokalnie ${commits(item.local.ahead)} do wypchnięcia` });
  }
  if (item.local?.dirty) {
    item.flags.push({ level: 'info', code: 'local-dirty', text: `niezacommitowane zmiany lokalnie (plików: ${item.local.dirty})` });
  }

  return item;
}

/**
 * The branches a lane shows on its right: where things can go, and where they went. A lane with
 * unfinished work shows every open destination; a lane that is only history shows what was used.
 */
function laneTrunks(repo, items, product) {
  const trunks = [];
  const add = (ref, extra = {}) => {
    const existing = trunks.find((trunk) => trunk.ref === ref);
    if (existing) return Object.assign(existing, extra);
    const described = describeRef(ref, repo);
    const branch = repo.branches[ref];
    const trunk = {
      ...described,
      webUrl: branch ? `${repo.webUrl}/-/tree/${ref.split('/').map(encodeURIComponent).join('/')}` : null,
      committedAt: branch?.committedAt ?? null,
      released: Boolean(described.version && repo.released && compareVersions(described.version, repo.released.version) <= 0),
      targeted: false,
      targetedByOpen: false,
      expected: false,
      note: null,
      ...extra,
    };
    trunks.push(trunk);
    return trunk;
  };

  const live = items.some((item) => !item.mr || item.mr.state === 'opened');
  if (live) {
    for (const rc of repo.rc.open) add(rc.name);
    const latestOpen = product?.latestOpen ?? null;
    if (repo.role === 'product' && latestOpen && !repo.branches[`${RC_PREFIX}${latestOpen}`]) {
      add(`${RC_PREFIX}${latestOpen}`, { rcState: 'absent', note: 'jeszcze nie ma w tym repozytorium' });
    }
    for (const candidate of repo.candidates) add(candidate);
    add(repo.defaultBranch);
  }

  const itemBranches = new Set(items.map((item) => item.branch));
  for (const item of items) {
    if (item.mr && !itemBranches.has(item.mr.targetRef)) {
      const trunk = add(item.mr.targetRef);
      trunk.targeted = true;
      if (item.mr.state === 'opened') {
        trunk.targetedByOpen = true;
        if (!trunk.exists && trunk.kind === 'rc') trunk.rcState = 'missing';
      }
    }
    if (item.expected && item.expected.reason !== 'stack') add(item.expected.ref).expected = true;
  }

  // A candidate that lacks part of the default branch or of the candidate before it is a
  // destination with a catch; say so where merge requests point at it.
  for (const trunk of trunks) {
    const state = repo.rcChain?.open.find((candidate) => candidate.name === trunk.ref);
    const broken = [state?.toPrevious, state?.toDefault].filter((relation) => relation && relation.level !== 'ok');
    trunk.health = broken.length ? { level: broken.some((relation) => relation.level === 'error') ? 'error' : 'warn', text: broken.map((relation) => relation.text).join('; ') } : null;
  }

  const kindRank = { rc: 0, candidate: 1, default: 2 };
  return trunks.sort(
    (a, b) =>
      (kindRank[a.kind] ?? 3) - (kindRank[b.kind] ?? 3) ||
      (a.version && b.version ? compareVersions(b.version, a.version) : 0) ||
      a.ref.localeCompare(b.ref),
  );
}
