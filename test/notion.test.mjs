import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  FETCH_TOOL,
  NotionError,
  QUERY_TOOL,
  cleanTitle,
  courierPrompt,
  describeFailure,
  findCallResult,
  normalizeTask,
  parseCourierStream,
  parseFetchedPage,
  parseReleaseVersionName,
  readSnapshot,
  refreshNotion,
  relatedPageCalls,
  selectMyOpenTickets,
  ticketsCall,
} from '../lib/notion.mjs';

const ME = '2edd872b-594c-8152-926d-00024204cb53';
const DEV = '6a6d21ee-d03c-408c-a7f3-a50f23da4dea';
const notionConfig = {
  model: 'haiku',
  mcpUrl: 'https://mcp.example/mcp',
  viewUrl: 'https://www.notion.so/db?v=view',
  tasksDataSource: 'collection://tasks',
  doneStatuses: ['Released to Prod', 'Archived'],
  projects: { '2fe1075227c080108d1fe08bbaa76da7': 'cryden', '1336c71be17e4a48b7fafff23a964f33': 'heiser' },
};

/** A row the way the query tool returns it: lists are JSON encoded strings. */
const row = (overrides = {}) => ({
  '': '1265',
  'Task name': '\\[Cryden\\]\\[Heiser\\] Integrations must show <b>when</b> they were created',
  Status: 'In QA',
  'QA assignee': `["user://${ME}"]`,
  Assignee: `["user://${DEV}"]`,
  '⛳ Release version': '["https://app.notion.com/p/4071075227c08091b030da45948fc092"]',
  'Sub-tasks': '["https://app.notion.com/p/40e1075227c0812ab3d6cb6de61e99df"]',
  Project: '["https://app.notion.com/p/2fe1075227c080108d1fe08bbaa76da7","https://app.notion.com/p/1336c71be17e4a48b7fafff23a964f33"]',
  'QA Automated': 'In Progress',
  'Created time': '2026-10-20T08:41:44.120Z',
  'Last edited time': '2026-11-10T07:37:27.761Z',
  url: 'https://app.notion.com/p/3ff1075227c08058b442c4d76ec60deb',
  ...overrides,
});

test('titles lose Notion markup', () => {
  assert.equal(cleanTitle('\\[Cryden\\]\\[Heiser\\] Integrations'), '[Cryden][Heiser] Integrations');
  assert.equal(cleanTitle('<b>Additional suppression lists </b>'), 'Additional suppression lists');
});

test('a row becomes a ticket', () => {
  const ticket = normalizeTask(row(), notionConfig);
  assert.equal(ticket.number, 1265);
  assert.equal(ticket.title, '[Cryden][Heiser] Integrations must show when they were created');
  assert.equal(ticket.pageId, '3ff1075227c08058b442c4d76ec60deb');
  assert.deepEqual(ticket.qaAssigneeIds, [ME]);
  assert.deepEqual(ticket.assigneeIds, [DEV]);
  assert.deepEqual(ticket.releaseVersionIds, ['4071075227c08091b030da45948fc092']);
  assert.deepEqual(ticket.subtaskIds, ['40e1075227c0812ab3d6cb6de61e99df']);
  assert.deepEqual(ticket.parentIds, []);
  assert.deepEqual(ticket.products, ['cryden', 'heiser']);
});

test('a fetched page carries the same fields as a row, with real arrays', () => {
  const fetched = {
    title: '[BACKEND] Integrations',
    text: `<page url="x">\n<properties>\n${JSON.stringify({
      '': '1311',
      'Task name': '\\[BACKEND\\] Integrations',
      Status: 'In Code Review',
      Assignee: [`user://${DEV}`],
      'Parent-task': ['https://app.notion.com/p/3ff1075227c08058b442c4d76ec60deb'],
      url: 'https://app.notion.com/p/40e1075227c0812ab3d6cb6de61e99df',
    })}\n</properties>\n<content>## Merge requests</content>`,
  };
  const task = normalizeTask(parseFetchedPage(fetched), notionConfig);
  assert.equal(task.number, 1311);
  assert.equal(task.status, 'In Code Review');
  assert.deepEqual(task.parentIds, ['3ff1075227c08058b442c4d76ec60deb']);
  assert.equal(parseFetchedPage({ text: 'no properties here' }), null);
});

test('release version names give product and version, other names give neither', () => {
  assert.deepEqual(parseReleaseVersionName('Heiser 5.11.0'), { product: 'heiser', version: '5.11.0' });
  assert.deepEqual(parseReleaseVersionName('Traffico Priorities'), { product: null, version: null });
});

test('only my unreleased tickets are kept, whatever the view returns', () => {
  const tasks = [
    normalizeTask(row(), notionConfig),
    normalizeTask(row({ '': '1143', Status: 'Released to Prod' }), notionConfig),
    normalizeTask(row({ '': '1273', 'QA assignee': '["user://someone-else"]' }), notionConfig),
    normalizeTask(row({ '': '781', 'QA assignee': '', Assignee: `["user://${ME}"]`, Status: 'Not started' }), notionConfig),
    normalizeTask(row({ '': '' }), notionConfig),
  ];
  const mine = selectMyOpenTickets(tasks, { me: { id: ME }, doneStatuses: notionConfig.doneStatuses });
  assert.deepEqual(mine.map((ticket) => ticket.number), [1265, 781]);
  // Before "me" is known the view's own filter is trusted.
  assert.equal(selectMyOpenTickets(tasks, { me: null, doneStatuses: notionConfig.doneStatuses }).length, 3);
});

test('tickets come from the saved view when one is configured', () => {
  assert.deepEqual(ticketsCall(notionConfig).args, { data: { mode: 'view', view_url: notionConfig.viewUrl, page_size: 100 } });
  assert.equal(ticketsCall(notionConfig, 'cursor-2').args.data.start_cursor, 'cursor-2');
});

test('without a view the metered query filters to "me" and to unreleased', () => {
  const { args } = ticketsCall({ ...notionConfig, viewUrl: null });
  assert.equal(args.data.mode, 'rows');
  assert.equal(args.data.data_source_url, 'collection://tasks');
  const [people, status] = args.data.filter.filters;
  assert.deepEqual(people.filters.map((filter) => [filter.property, filter.value.value]), [['QA assignee', 'me'], ['Assignee', 'me']]);
  assert.deepEqual(status.value.map((option) => option.value), ['Released to Prod', 'Archived']);
});

test('related pages are fetched when unknown or stale, release versions only once', () => {
  const tickets = [normalizeTask(row(), notionConfig), normalizeTask(row({ '': '1311', url: 'https://app.notion.com/p/40e1075227c0812ab3d6cb6de61e99df', 'Sub-tasks': '', 'Parent-task': '["https://app.notion.com/p/3ff1075227c08058b442c4d76ec60deb"]' }), notionConfig)];
  // The sub-task is itself one of the tickets, so only the release version is missing.
  assert.deepEqual(relatedPageCalls(tickets, null).map((call) => [call.kind, call.pageId]), [['version', '4071075227c08091b030da45948fc092']]);

  const alone = [tickets[0]];
  const now = Date.parse('2026-11-10T12:00:00Z');
  const fresh = { related: { '40e1075227c0812ab3d6cb6de61e99df': { fetchedAt: '2026-11-10T09:00:00Z' } }, releaseVersions: { '4071075227c08091b030da45948fc092': { name: 'Heiser 5.11.0' } } };
  assert.deepEqual(relatedPageCalls(alone, fresh, now), []);
  const stale = { ...fresh, related: { '40e1075227c0812ab3d6cb6de61e99df': { fetchedAt: '2026-11-09T09:00:00Z' } } };
  const calls = relatedPageCalls(alone, stale, now);
  assert.deepEqual(calls.map((call) => call.kind), ['task']);
  assert.equal(calls[0].tool, FETCH_TOOL);
  assert.deepEqual(calls[0].args, { id: 'https://www.notion.so/40e1075227c0812ab3d6cb6de61e99df' });
});

// --- the courier's output stream ---------------------------------------------------------------

const call = { key: 'tickets', tool: QUERY_TOOL, args: { data: { mode: 'view', view_url: 'u', page_size: 100 } } };
const line = (event) => JSON.stringify(event);
const init = (status = 'connected') => line({ type: 'system', subtype: 'init', tools: [QUERY_TOOL], mcp_servers: [{ name: 'notion', status }] });
const use = (id, input, name = QUERY_TOOL) => line({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, text, isError = false) =>
  line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: isError ? text : [{ type: 'text', text }] }] } });

test('the result is taken from the call that carried exactly the requested arguments', () => {
  const stream = parseCourierStream(
    [
      init(),
      use('a', { __unparsedToolInput: { raw: '{"data": {...}}}' } }),
      result('a', '<tool_use_error>could not be parsed as JSON</tool_use_error>', true),
      use('b', { data: { mode: 'view', view_url: 'OTHER', page_size: 100 } }),
      result('b', '{"results":[{"":"999"}]}'),
      use('c', { ...call.args, telemetry: { intent: 'courier call' } }),
      result('c', '{"results":[{"":"1265"}]}'),
      line({ type: 'result', subtype: 'success', result: 'DONE', total_cost_usd: 0.005 }),
      'not json at all',
    ].join('\n'),
  );
  assert.equal(findCallResult(stream, call), '{"results":[{"":"1265"}]}');
  assert.equal(stream.result.total_cost_usd, 0.005);
});

test('a call the model changed is not accepted', () => {
  const stream = parseCourierStream([init(), use('a', { data: { mode: 'view', view_url: 'u', page_size: 50 } }), result('a', '{"results":[]}')].join('\n'));
  assert.equal(findCallResult(stream, call), null);
});

test('failures are explained in terms the user can act on', () => {
  const quota = parseCourierStream(
    [init(), use('a', call.args), result('a', 'Your workspace has used up its Query Data Source allowance for SQL and rows-mode queries. The allowance resets within 60 minutes.', true)].join('\n'),
  );
  assert.equal(describeFailure(quota).kind, 'quota');

  const signedOut = parseCourierStream(init('needs-auth'));
  assert.equal(describeFailure(signedOut).kind, 'auth');
  assert.match(describeFailure(signedOut).message, /\/mcp/);

  assert.equal(describeFailure(parseCourierStream(''), 'spawn failed').kind, 'failed');
});

test('the prompt states every call with its exact arguments', () => {
  const prompt = courierPrompt([call, { key: 'page:x', tool: FETCH_TOOL, args: { id: 'https://www.notion.so/x' } }]);
  assert.match(prompt, /Make exactly 2 tool calls/);
  assert.ok(prompt.includes(JSON.stringify(call.args)));
  assert.ok(prompt.includes('{"id":"https://www.notion.so/x"}'));
});

// --- the whole refresh, with the courier replaced ------------------------------------------------

test('a refresh reads every page of the view, resolves what the tickets point at and stores the snapshot', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tbm-notion-'));
  const requests = [];
  const page = (properties) => ({ text: `<properties>\n${JSON.stringify(properties)}\n</properties>` });
  const courier = async (calls) => {
    requests.push(calls.map((entry) => entry.key));
    const results = new Map();
    for (const entry of calls) {
      if (entry.key === 'tickets') {
        results.set(
          'tickets',
          entry.args.data.start_cursor
            ? { results: [row({ '': '1143', Status: 'Released to Prod', url: 'https://app.notion.com/p/3df1075227c0800697c5c852e3845c0d' })], has_more: false }
            : { results: [row()], has_more: true, next_cursor: 'page-2' },
        );
      } else if (entry.key === 'self') results.set('self', { user: { id: ME, name: 'Me' } });
      else if (entry.key === 'users') results.set('users', { results: [{ type: 'person', id: DEV, name: 'Dev Person' }, { type: 'bot', id: 'bot', name: 'Bot' }] });
      else if (entry.kind === 'version') results.set(entry.key, page({ Name: 'Heiser 5.11.0', url: 'https://app.notion.com/p/4071075227c08091b030da45948fc092' }));
      else results.set(entry.key, page({ '': '1311', 'Task name': 'Backend part', Status: 'In Code Review', url: 'https://app.notion.com/p/40e1075227c0812ab3d6cb6de61e99df' }));
    }
    return { results, tools: [QUERY_TOOL], costUsd: 0.01, durationMs: 1 };
  };

  const snapshot = await refreshNotion({ notionConfig, dataDir, courier });

  assert.deepEqual(requests[0], ['tickets']);
  assert.deepEqual(requests[1], ['tickets'], 'the second page of the view');
  assert.deepEqual(requests[2].slice(0, 2), ['self', 'users']);
  assert.deepEqual(snapshot.tickets.map((ticket) => ticket.number), [1265], 'the released ticket from page two is dropped');
  assert.deepEqual(snapshot.me, { id: ME, name: 'Me' });
  assert.equal(snapshot.users[DEV], 'Dev Person');
  assert.equal(snapshot.users.bot, undefined);
  assert.equal(snapshot.users[ME], null, 'a person the list does not know is remembered as nameless, not asked for again');
  assert.equal(snapshot.related['40e1075227c0812ab3d6cb6de61e99df'].number, 1311);
  assert.deepEqual(snapshot.releaseVersions['4071075227c08091b030da45948fc092'], {
    name: 'Heiser 5.11.0',
    url: 'https://app.notion.com/p/4071075227c08091b030da45948fc092',
    product: 'heiser',
    version: '5.11.0',
  });
  assert.equal(snapshot.source, 'view');
  assert.deepEqual(await readSnapshot(dataDir), snapshot);

  // The second refresh knows everything already and asks only for the tickets.
  requests.length = 0;
  await refreshNotion({ notionConfig, dataDir, previous: snapshot, courier });
  assert.deepEqual(requests, [['tickets'], ['tickets']]);
  await fs.rm(dataDir, { recursive: true });
});

test('a quota error is not retried and surfaces as it is', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tbm-notion-'));
  let attempts = 0;
  const courier = async () => {
    attempts += 1;
    throw new NotionError('limit', { kind: 'quota' });
  };
  await assert.rejects(refreshNotion({ notionConfig, dataDir, courier }), { kind: 'quota' });
  assert.equal(attempts, 1);

  attempts = 0;
  const flaky = async () => {
    attempts += 1;
    throw new NotionError('model slipped');
  };
  await assert.rejects(refreshNotion({ notionConfig, dataDir, courier: flaky }), { kind: 'failed' });
  assert.equal(attempts, 2, 'a plain failure gets one more attempt');
  await fs.rm(dataDir, { recursive: true });
});
