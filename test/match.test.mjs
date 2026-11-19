import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  branchMatchesTicket,
  descriptionMatchesTicket,
  matchMergeRequest,
  subjectMentionsTicket,
  titleMatchesTicket,
} from '../lib/match.mjs';

test('a branch belongs to a ticket when the number stands on its own', () => {
  assert.equal(branchMatchesTicket('feat/1174-integration-access', 1174), true);
  assert.equal(branchMatchesTicket('test/1265-created-at-owner-filter', 1265), true);
  assert.equal(branchMatchesTicket('fix/1143', 1143), true);
  assert.equal(branchMatchesTicket('feat/11740-something', 1174), false);
  assert.equal(branchMatchesTicket('feat/21174-something', 1174), false);
  assert.equal(branchMatchesTicket('test/auto-global-pause-ui-fixes', 1282), false);
});

test('a title names a ticket in the forms the team uses', () => {
  assert.equal(titleMatchesTicket('feat(1174): integration access', 1174), true);
  assert.equal(titleMatchesTicket('test(cryden): cover buckets blocked through their contract (1282)', 1282), true);
  assert.equal(titleMatchesTicket('Feat/975 additional suppression lists', 975), true);
  assert.equal(titleMatchesTicket('feat(omnisend): batch-tag contacts (#887)', 887), true);
});

test('a merge request reference or a version in a title is not a ticket', () => {
  assert.equal(titleMatchesTicket('Revert "Test/internal endpoints and smoke tests" (!201)', 201), false);
  assert.equal(titleMatchesTicket('release-candidate/5.10.0', 10), false);
  assert.equal(titleMatchesTicket('chore: bump node version to 24.22.1', 22), false);
});

test('a description counts only when it names the ticket on purpose', () => {
  assert.equal(descriptionMatchesTicket('## feat\n\nNotion: 1174 — Cryden: integration access', 1174), true);
  assert.equal(descriptionMatchesTicket('Ticket: 1136\n\nDev MRs: ...', 1136), true);
  assert.equal(descriptionMatchesTicket('## What\n\nCoverage for 1265. Integrations and buckets get createdAt', 1265), true);
  assert.equal(descriptionMatchesTicket('Pipeline 3048975123 was green; see also 1174 in the evidence', 975), false);
  assert.equal(descriptionMatchesTicket('The 1265 specs also touch what 1174 will change', 1174), false);
});

test('a link to the ticket page ties a merge request to it whatever the number', () => {
  const description = 'See https://app.notion.com/p/Integration-access-3e51075227c0809d8e6fe85723bcae2e';
  assert.equal(descriptionMatchesTicket(description, 1174, '3e51075227c0809d8e6fe85723bcae2e'), true);
  assert.equal(descriptionMatchesTicket(description, 1174, '0000075227c0809d8e6fe85723bcae2e'), false);
});

test('matching reports what tied the merge request to the ticket', () => {
  const ticket = { number: 1265, pageId: null, createdAt: '2026-10-20T08:41:44.120Z' };
  const base = { created_at: '2026-11-04T10:00:00Z', description: '' };
  assert.equal(matchMergeRequest({ ...base, source_branch: 'feat/1265-created-at-owner-filter', title: 'feat: dashboard suppressions created at' }, ticket), 'branch');
  assert.equal(matchMergeRequest({ ...base, source_branch: 'feat/created-at', title: 'feat(1265): creation date' }, ticket), 'title');
  assert.equal(matchMergeRequest({ ...base, source_branch: 'feat/created-at', title: 'creation date', description: 'Ticket: 1265' }, ticket), 'description');
  assert.equal(matchMergeRequest({ ...base, source_branch: 'feat/other', title: 'other' }, ticket), null);
});

test('a merge request opened long before the ticket existed is someone else\'s number', () => {
  const ticket = { number: 975, pageId: null, createdAt: '2026-07-01T09:34:46.140Z' };
  const old = { source_branch: 'feature/COREG-975', title: 'Resolve COREG-975', description: '', created_at: '2022-09-02T10:00:00Z' };
  assert.equal(matchMergeRequest(old, ticket), null);
  assert.equal(matchMergeRequest({ ...old, created_at: '2026-06-20T10:00:00Z' }, ticket), 'branch');
});

test('commit subjects carry the ticket in parentheses', () => {
  assert.equal(subjectMentionsTicket('test(cryden): force a tooltip hover only on a disabled trigger (1282)', 1282), true);
  assert.equal(subjectMentionsTicket('Merge branch develop into test/x', 1282), false);
  assert.equal(subjectMentionsTicket('fix(heiser): fixme the userId limit (No-1261)', 1261), false);
});
