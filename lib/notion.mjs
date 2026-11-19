/**
 * Tickets from Notion.
 *
 * Notion is reachable only through its hosted MCP server, which authenticates with the OAuth
 * session Claude Code already holds. So a refresh starts a headless `claude -p` that acts as a
 * courier: it is told the exact tool calls to make, and the rows are read from the raw tool
 * results in its output stream. The model never transcribes data, and a call whose arguments
 * differ from the requested ones is rejected, so what ends up in the snapshot is what Notion
 * returned for the query this file wrote.
 *
 * Which query: Notion meters ad-hoc queries (`rows` and `sql` modes) with an hourly allowance
 * shared by the whole workspace, about ten calls. Running a saved view is not metered. So the
 * tickets come from a view filtered to "assigned to me, not released" (`notion.viewUrl`), and
 * the pages they point at (parent tasks, sub-tasks, release versions) are fetched one by one
 * and kept, because they change rarely. The ad-hoc query is only the fallback for a setup
 * without a view.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { deepEqual, notionPageId, parseJsonList } from './util.mjs';

export const QUERY_TOOL = 'mcp__notion__notion-query-data-sources';
export const FETCH_TOOL = 'mcp__notion__notion-fetch';
export const USERS_TOOL = 'mcp__notion__notion-get-users';
export const SELF_TOOL = 'mcp__notion__notion-get-self';

/** Property names of the "Internal Apps Tasks" database. */
const P = {
  number: '',
  title: 'Task name',
  status: 'Status',
  assignee: 'Assignee',
  qaAssignee: 'QA assignee',
  qaAutomated: 'QA Automated',
  priority: 'Priority',
  flag: 'Ticket flag',
  type: 'Type',
  tags: 'Tags',
  releaseVersion: '⛳ Release version',
  parent: 'Parent-task',
  subtasks: 'Sub-tasks',
  project: 'Project',
  created: 'Created time',
  edited: 'Last edited time',
};

const HOUR = 3_600_000;
/** A parent's or sub-task's number never changes, its status does. */
const RELATED_MAX_AGE_MS = 6 * HOUR;
const MAX_VIEW_PAGES = 5;
const MAX_PAGE_FETCHES = 15;

export class NotionError extends Error {
  constructor(message, { kind = 'failed' } = {}) {
    super(message);
    this.name = 'NotionError';
    /**
     * 'auth': the user has to sign in again. 'quota': the workspace's hourly allowance is used
     * up. Neither is worth retrying. 'failed' may succeed on a second attempt.
     */
    this.kind = kind;
  }
}

// ---------------------------------------------------------------------------------------------
// Rows -> tickets (pure)

/** Notion returns titles with inline HTML tags and escaped markdown punctuation. */
export function cleanTitle(raw) {
  return String(raw ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/\\([\\`*_{}[\]()#+\-.!~<>|])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

const userId = (value) => String(value).replace(/^user:\/\//, '');
const pageIds = (value) => parseJsonList(value).map(notionPageId).filter(Boolean);
const pageUrl = (pageId) => `https://www.notion.so/${pageId}`;

/** One row of the tasks database as the tool returns it -> the shape the rest of the tool uses. */
export function normalizeTask(row, { projects = {} } = {}) {
  const rawNumber = String(row[P.number] ?? '').trim();
  const projectIds = pageIds(row[P.project]);
  return {
    number: /^\d+$/.test(rawNumber) ? Number(rawNumber) : null,
    title: cleanTitle(row[P.title]),
    url: row.url ?? null,
    pageId: notionPageId(row.url),
    status: row[P.status] ?? null,
    qaAutomated: row[P.qaAutomated] ?? null,
    priority: row[P.priority] ?? null,
    flag: row[P.flag] ?? null,
    types: parseJsonList(row[P.type]),
    tags: parseJsonList(row[P.tags]),
    assigneeIds: parseJsonList(row[P.assignee]).map(userId),
    qaAssigneeIds: parseJsonList(row[P.qaAssignee]).map(userId),
    releaseVersionIds: pageIds(row[P.releaseVersion]),
    parentIds: pageIds(row[P.parent]),
    subtaskIds: pageIds(row[P.subtasks]),
    products: [...new Set(projectIds.map((id) => projects[id]).filter(Boolean))],
    createdAt: row[P.created] ?? null,
    editedAt: row[P.edited] ?? null,
  };
}

/** `"Heiser 5.11.0"` -> `{ product: 'heiser', version: '5.11.0' }`; `"Traffico Priorities"` -> no version. */
export function parseReleaseVersionName(name) {
  const match = /^\s*([A-Za-z][\w-]*)\s+v?(\d+\.\d+\.\d+)\b/.exec(String(name ?? ''));
  return match ? { product: match[1].toLowerCase(), version: match[2] } : { product: null, version: null };
}

/**
 * Keeps what the tool is about: tickets assigned to `me` that are not released. The view is
 * expected to filter this way already; repeating it here means a view that is too wide costs
 * time, not correctness.
 */
export function selectMyOpenTickets(tasks, { me, doneStatuses }) {
  return tasks.filter(
    (task) =>
      task.number !== null &&
      !doneStatuses.includes(task.status) &&
      (!me || task.assigneeIds.includes(me.id) || task.qaAssigneeIds.includes(me.id)),
  );
}

/** The `<properties>` block of a fetched page, which holds the same fields a database row has. */
export function parseFetchedPage(result) {
  const text = String(result?.text ?? '');
  const block = /<properties>\s*([\s\S]*?)\s*<\/properties>/.exec(text)?.[1];
  if (!block) return null;
  try {
    return JSON.parse(block);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Tool calls (pure)

const personIsMe = (property) => ({
  type: 'property',
  property,
  propertyType: 'person',
  operator: 'person_contains',
  value: { type: 'relative', value: 'me' },
});

/**
 * The query for the user's tickets: the saved view when one is configured, otherwise the
 * metered ad-hoc query with the same filter.
 */
export function ticketsCall(notionConfig, cursor = null) {
  if (notionConfig.viewUrl) {
    return {
      key: 'tickets',
      tool: QUERY_TOOL,
      args: { data: { mode: 'view', view_url: notionConfig.viewUrl, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) } },
    };
  }
  return {
    key: 'tickets',
    tool: QUERY_TOOL,
    args: {
      data: {
        mode: 'rows',
        data_source_url: notionConfig.tasksDataSource,
        filter: {
          type: 'group',
          operator: 'and',
          filters: [
            { type: 'group', operator: 'or', filters: [personIsMe(P.qaAssignee), personIsMe(P.assignee)] },
            {
              type: 'property',
              property: P.status,
              propertyType: 'status',
              operator: 'status_is_not',
              value: notionConfig.doneStatuses.map((value) => ({ type: 'is_option', value })),
            },
          ],
        },
        sort: [{ property: P.edited, direction: 'descending' }],
        limit: 100,
      },
    },
  };
}

/**
 * The pages the tickets point at that are not known yet, or were read too long ago: parent
 * tasks, sub-tasks and release versions. A release version's name does not change, so it is
 * read once.
 *
 * @returns {{ key: string, kind: 'task'|'version', pageId: string, tool: string, args: object }[]}
 */
export function relatedPageCalls(tickets, previous, now = Date.now()) {
  const own = new Set(tickets.map((ticket) => ticket.pageId));
  const calls = new Map();
  const want = (pageId, kind) => {
    if (calls.has(pageId) || own.has(pageId)) return;
    calls.set(pageId, { key: `page:${pageId}`, kind, pageId, tool: FETCH_TOOL, args: { id: pageUrl(pageId) } });
  };

  for (const ticket of tickets) {
    for (const pageId of [...ticket.parentIds, ...ticket.subtaskIds]) {
      const known = previous?.related?.[pageId];
      if (!known || now - (Date.parse(known.fetchedAt) || 0) > RELATED_MAX_AGE_MS) want(pageId, 'task');
    }
    for (const pageId of ticket.releaseVersionIds) {
      if (!previous?.releaseVersions?.[pageId]) want(pageId, 'version');
    }
  }
  // Pages never read before come first; the rest wait for the next refresh if there are too many.
  return [...calls.values()]
    .sort((a, b) => Number(Boolean(previous?.related?.[a.pageId])) - Number(Boolean(previous?.related?.[b.pageId])))
    .slice(0, MAX_PAGE_FETCHES);
}

export function courierPrompt(calls) {
  const steps = calls
    .map(
      (call, index) =>
        `Call ${index + 1}: tool \`${call.tool}\`. The complete arguments object is the JSON on the next line.\n${JSON.stringify(call.args)}`,
    )
    .join('\n\n');
  return [
    `You are a courier. Make exactly ${calls.length} tool call${calls.length === 1 ? '' : 's'}, in the order given below.`,
    'For each call pass the arguments object exactly as written: same keys, same values, nothing added, nothing removed, nothing wrapped in another object.',
    'If a call is rejected as malformed, send the same arguments again. Do not call any other tool and do not summarise the results.',
    'When every call has returned, reply with the single word DONE.',
    '',
    steps,
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------
// Reading the courier's output stream (pure)

const resultText = (content) =>
  typeof content === 'string'
    ? content
    : (content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');

/** Splits `--output-format stream-json` output into what the calls need. */
export function parseCourierStream(stdout) {
  const stream = { init: null, toolUses: [], toolResults: new Map(), result: null };
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'system' && event.subtype === 'init') stream.init = event;
    else if (event.type === 'result') stream.result = event;
    else if (event.type === 'assistant') {
      for (const block of event.message?.content ?? []) {
        if (block.type === 'tool_use') stream.toolUses.push({ id: block.id, name: block.name, input: block.input });
      }
    } else if (event.type === 'user') {
      for (const block of event.message?.content ?? []) {
        if (block.type === 'tool_result') {
          stream.toolResults.set(block.tool_use_id, { isError: Boolean(block.is_error), text: resultText(block.content) });
        }
      }
    }
  }
  return stream;
}

/** Optional bookkeeping fields every Notion tool accepts; the model sometimes fills them in. */
const META_KEYS = new Set(['telemetry', 'skill', 'instructions_version']);
const withoutMeta = (input) => Object.fromEntries(Object.entries(input ?? {}).filter(([key]) => !META_KEYS.has(key)));

/** The tool result for one requested call, or `null` when no call matched it exactly. */
export function findCallResult(stream, call) {
  for (const use of stream.toolUses) {
    if (use.name !== call.tool || !deepEqual(withoutMeta(use.input), call.args)) continue;
    const result = stream.toolResults.get(use.id);
    if (result && !result.isError) return result.text;
  }
  return null;
}

/** Why a courier run did not deliver, as an error the page can show. */
export function describeFailure(stream, stderr = '') {
  const server = stream.init?.mcp_servers?.find((entry) => entry.name === 'notion');
  if (stream.init && (!server || server.status !== 'connected')) {
    return new NotionError(
      `Brak połączenia z Notion MCP (status: ${server?.status ?? 'brak serwera'}). Otwórz Claude Code, wpisz /mcp i zaloguj się ponownie do Notion.`,
      { kind: 'auth' },
    );
  }
  const errors = [...stream.toolResults.values()].filter((entry) => entry.isError).map((entry) => entry.text);
  const lastError = errors.at(-1) ?? '';
  if (/used up its .* allowance|allowance resets/i.test(lastError)) {
    return new NotionError(
      'Workspace wyczerpał godzinny limit zapytań Notion (tryb rows/SQL, wspólny dla wszystkich). Limit odnawia się w ciągu 60 minut; zapisany widok (notion.viewUrl) go nie zużywa.',
      { kind: 'quota' },
    );
  }
  if (/entitlement|requires a .* plan|sign in|unauthori[sz]ed|authenticat/i.test(lastError)) {
    return new NotionError(`Notion odrzucił zapytanie: ${lastError.slice(0, 300)}`, { kind: 'auth' });
  }
  if (!stream.init) {
    return new NotionError(`Nie udało się uruchomić \`claude -p\`: ${stderr.trim().slice(0, 300) || 'brak wyjścia'}`);
  }
  const hint = lastError || (typeof stream.result?.result === 'string' ? stream.result.result : '') || stderr;
  return new NotionError(`Zapytanie do Notion nie zostało wykonane zgodnie z instrukcją. ${hint.trim().slice(0, 300)}`);
}

// ---------------------------------------------------------------------------------------------
// Running the courier

async function parseToolJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    // A result too large for the context is written to a file and replaced by a pointer to it.
    const saved = /saved to (\/\S+?\.(?:txt|json))/.exec(text)?.[1];
    if (!saved) throw new NotionError(`Notion zwrócił odpowiedź, której nie umiem odczytać: ${text.slice(0, 200)}`);
    return JSON.parse(await fs.readFile(saved, 'utf8'));
  }
}

/**
 * Runs the calls through a headless Claude Code session and returns their parsed results by key.
 *
 * The session is isolated on purpose: no user settings (they may carry bypassPermissions), no
 * skills, no built-in tools, and of the Notion tools only the ones this run needs. Dropping the
 * other tool definitions also shrinks the request from ~110k tokens to ~20k.
 *
 * With `partial`, calls the model skipped or got wrong are left out of the result instead of
 * failing the run.
 */
export function runCourier(calls, { model, mcpUrl, knownTools = [], partial = false, timeoutMs = 180_000, bin = 'claude' }) {
  const allowed = [...new Set(calls.map((call) => call.tool))];
  const disallowed = knownTools.filter((name) => !allowed.includes(name));
  const args = [
    '-p',
    courierPrompt(calls),
    '--model',
    model,
    '--output-format',
    'stream-json',
    '--verbose',
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    JSON.stringify({ mcpServers: { notion: { type: 'http', url: mcpUrl } } }),
    '--tools',
    '',
    '--allowedTools',
    allowed.join(','),
    ...(disallowed.length ? ['--disallowedTools', disallowed.join(',')] : []),
    '--permission-prompts',
    'none',
    '--disable-slash-commands',
    '--no-chrome',
    '--no-session-persistence',
    '--max-budget-usd',
    '1',
  ];

  const env = { ...process.env, MAX_MCP_OUTPUT_TOKENS: '250000' };
  // Set when this server was itself started from inside a Claude Code session.
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: os.tmpdir(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new NotionError(`Notion nie odpowiedział w ${Math.round(timeoutMs / 1000)} s.`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(
        new NotionError(
          error.code === 'ENOENT' ? 'Nie znaleziono polecenia `claude` (Claude Code CLI).' : error.message,
          { kind: error.code === 'ENOENT' ? 'auth' : 'failed' },
        ),
      );
    });
    child.on('close', async () => {
      clearTimeout(timer);
      try {
        const stream = parseCourierStream(stdout);
        const results = new Map();
        for (const call of calls) {
          const text = findCallResult(stream, call);
          if (text === null) {
            if (partial && stream.init) continue;
            throw describeFailure(stream, stderr);
          }
          results.set(call.key, await parseToolJson(text));
        }
        if (partial && results.size === 0 && calls.length > 0) throw describeFailure(stream, stderr);
        resolve({
          results,
          tools: stream.init?.tools ?? [],
          costUsd: stream.result?.total_cost_usd ?? null,
          durationMs: stream.result?.duration_ms ?? null,
        });
      } catch (error) {
        reject(error instanceof NotionError ? error : new NotionError(error.message));
      }
    });
  });
}

async function withRetry(courier, calls, options) {
  try {
    return await courier(calls, options);
  } catch (error) {
    if (!(error instanceof NotionError) || error.kind !== 'failed') throw error;
    return courier(calls, options);
  }
}

// ---------------------------------------------------------------------------------------------
// Snapshot

const snapshotFile = (dataDir) => path.join(dataDir, 'notion.json');
const toolsFile = (dataDir) => path.join(dataDir, 'notion-tools.json');

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2));
  await fs.rename(temporary, file);
}

export const readSnapshot = (dataDir) => readJson(snapshotFile(dataDir), null);

const relatedEntry = (properties, notionConfig, fetchedAt) => {
  const task = normalizeTask(properties, notionConfig);
  return {
    number: task.number,
    title: task.title,
    status: task.status,
    url: task.url,
    pageId: task.pageId,
    products: task.products,
    assigneeIds: task.assigneeIds,
    createdAt: task.createdAt,
    fetchedAt,
  };
};

/**
 * Asks Notion for the user's open tickets and what they point at, and stores the snapshot.
 *
 * @param {{
 *   notionConfig: object, dataDir: string, previous?: object|null,
 *   onProgress?: (text: string) => void, courier?: typeof runCourier,
 * }} input `courier` is replaceable so the flow can be tested without Notion
 */
export async function refreshNotion({ notionConfig, dataDir, previous = null, onProgress = () => {}, courier = runCourier }) {
  const known = await readJson(toolsFile(dataDir), { tools: [] });
  const options = { model: notionConfig.model, mcpUrl: notionConfig.mcpUrl, knownTools: known.tools };
  const seenTools = new Set();
  const warnings = [];
  let costUsd = 0;
  const account = (run) => {
    costUsd += run.costUsd ?? 0;
    run.tools.forEach((name) => seenTools.add(name));
    return run;
  };

  // --- who "me" is: needed once, to check the rows a view returns -----------------------------
  let me = previous?.me ?? null;
  const users = { ...(previous?.users ?? {}) };

  // --- the tickets ----------------------------------------------------------------------------
  onProgress('Notion: pobieram tickety przypisane do Ciebie');
  const rows = [];
  let cursor = null;
  for (let page = 0; page < MAX_VIEW_PAGES; page += 1) {
    const run = account(await withRetry(courier, [ticketsCall(notionConfig, cursor)], options));
    const payload = run.results.get('tickets');
    rows.push(...(payload.results ?? []));
    cursor = payload.has_more ? (payload.next_cursor ?? null) : null;
    if (!cursor) break;
    if (!notionConfig.viewUrl || page === MAX_VIEW_PAGES - 1) {
      warnings.push(`Notion ma więcej ticketów, niż wczytałem (${rows.length}); zawęź widok do swoich niewydanych ticketów.`);
      break;
    }
  }
  const tasks = rows.map((row) => normalizeTask(row, notionConfig));

  // --- pages the tickets point at, the user list, and "me" ------------------------------------
  const provisional = selectMyOpenTickets(tasks, { me, doneStatuses: notionConfig.doneStatuses });
  const pageCalls = relatedPageCalls(provisional, previous);
  const people = provisional.flatMap((ticket) => [...ticket.assigneeIds, ...ticket.qaAssigneeIds]);
  const followUps = [
    ...(me ? [] : [{ key: 'self', tool: SELF_TOOL, args: {} }]),
    ...(people.some((id) => !(id in users)) ? [{ key: 'users', tool: USERS_TOOL, args: { page_size: 100 } }] : []),
    ...pageCalls,
  ];

  const related = { ...(previous?.related ?? {}) };
  const releaseVersions = { ...(previous?.releaseVersions ?? {}) };
  if (followUps.length) {
    onProgress(`Notion: pobieram powiązane strony (${followUps.length})`);
    try {
      const run = account(await courier(followUps, { ...options, partial: true }));
      const fetchedAt = new Date().toISOString();

      const self = run.results.get('self')?.user;
      if (self?.id) me = { id: self.id, name: self.name ?? null };
      if (run.results.has('users')) {
        for (const user of run.results.get('users').results ?? []) {
          if (user.type === 'person' && user.id) users[user.id] = user.name;
        }
        // Someone the list does not know (a guest, a removed account) stays nameless; asking
        // again on every refresh would not change that.
        for (const id of people) if (!(id in users)) users[id] = null;
      }
      for (const call of pageCalls) {
        const result = run.results.get(call.key);
        const properties = result ? parseFetchedPage(result) : null;
        if (!properties) continue;
        if (call.kind === 'version') {
          const name = cleanTitle(properties.Name ?? result.title);
          releaseVersions[call.pageId] = { name, url: properties.url ?? pageUrl(call.pageId), ...parseReleaseVersionName(name) };
        } else {
          related[call.pageId] = relatedEntry({ ...properties, url: properties.url ?? pageUrl(call.pageId) }, notionConfig, fetchedAt);
        }
      }
      const missing = pageCalls.filter((call) => !run.results.has(call.key)).length;
      if (missing) warnings.push(`Nie udało się odczytać ${missing} powiązanych stron Notion; spróbuję przy następnym odświeżeniu.`);
    } catch (error) {
      if (error instanceof NotionError && error.kind === 'auth') throw error;
      warnings.push(`Nie udało się pobrać powiązań z Notion (zostają poprzednie): ${error.message}`);
    }
  }

  const tickets = selectMyOpenTickets(tasks, { me, doneStatuses: notionConfig.doneStatuses });

  // Keep only what the current tickets still point at.
  const referenced = new Set(tickets.flatMap((ticket) => [...ticket.parentIds, ...ticket.subtaskIds, ...ticket.releaseVersionIds]));
  for (const store of [related, releaseVersions]) {
    for (const pageId of Object.keys(store)) if (!referenced.has(pageId)) delete store[pageId];
  }

  // A run lists every tool it was not told to drop, so a name missing from the deny list (the
  // first run, or a tool Notion added since) shows up here and is dropped from the next run on.
  if ([...seenTools].some((name) => !known.tools.includes(name))) {
    const tools = [...new Set([...known.tools, ...seenTools])].sort();
    await writeJson(toolsFile(dataDir), { updatedAt: new Date().toISOString(), tools });
  }

  const snapshot = {
    fetchedAt: new Date().toISOString(),
    source: notionConfig.viewUrl ? 'view' : 'rows',
    me,
    tickets,
    related,
    releaseVersions,
    users,
    warnings,
    costUsd,
  };
  await writeJson(snapshotFile(dataDir), snapshot);
  return snapshot;
}
