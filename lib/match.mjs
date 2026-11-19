/**
 * Deciding whether a branch or a merge request belongs to a ticket. GitLab's `search` matches any
 * substring of the title and description, so its results are only candidates: `975` also finds a
 * pipeline id that happens to contain those digits. Everything here is pure.
 */

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** How long before the ticket existed a merge request may have been opened and still belong to it. */
const CREATED_BEFORE_TICKET_DAYS = 45;

/** `feat/1174-integration-access`, `test/1265-created-at`: the number as its own run of digits. */
export function branchMatchesTicket(branchName, number) {
  return new RegExp(`(?:^|[^0-9])${escapeRegExp(number)}(?:[^0-9]|$)`).test(String(branchName ?? ''));
}

/**
 * `feat(1174): ...`, `... (1265)`, `Feat/975 ...`, `(#887)`. A number after `!` is a merge request
 * reference and one beside a dot is part of a version, so neither counts.
 */
export function titleMatchesTicket(title, number) {
  return new RegExp(`(?:^|[^0-9!.])${escapeRegExp(number)}(?:[^0-9.]|$)`).test(String(title ?? ''));
}

/**
 * A description counts only when it names the ticket on purpose: a `Ticket:` / `Notion:` line,
 * the "Coverage for N" opening the QA merge requests use, or a link to the ticket's Notion page.
 */
export function descriptionMatchesTicket(description, number, pageId = null) {
  const text = String(description ?? '');
  if (pageId && text.replaceAll('-', '').toLowerCase().includes(String(pageId).toLowerCase())) return true;
  const n = escapeRegExp(number);
  return (
    new RegExp(`(?:^|\\n)[ \\t>*_-]*(?:ticket|notion|task|closes|refs?)\\b[^\\n0-9]{0,12}#?${n}(?:[^0-9]|$)`, 'i').test(
      text,
    ) || new RegExp(`\\bcoverage for\\s+#?${n}(?:[^0-9]|$)`, 'i').test(text)
  );
}

/**
 * @param {{ source_branch: string, title: string, description?: string, created_at?: string }} mr
 * @param {{ number: string|number, pageId?: string|null, createdAt?: string|null }} ticket
 * @returns {'branch'|'title'|'description'|null} what tied the merge request to the ticket
 */
export function matchMergeRequest(mr, ticket) {
  if (ticket.createdAt && mr.created_at) {
    const earliest = new Date(ticket.createdAt).getTime() - CREATED_BEFORE_TICKET_DAYS * 86_400_000;
    if (new Date(mr.created_at).getTime() < earliest) return null;
  }
  if (branchMatchesTicket(mr.source_branch, ticket.number)) return 'branch';
  if (titleMatchesTicket(mr.title, ticket.number)) return 'title';
  if (descriptionMatchesTicket(mr.description, ticket.number, ticket.pageId)) return 'description';
  return null;
}

/** Commit subjects in this organisation end with the ticket in parentheses: `... (1282)`. */
export function subjectMentionsTicket(subject, number) {
  return new RegExp(`\\(#?${escapeRegExp(number)}\\)`).test(String(subject ?? ''));
}
