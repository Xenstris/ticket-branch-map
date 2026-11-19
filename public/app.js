import { envLabel, isLive, layoutTicket } from './graph.js';

// ---------------------------------------------------------------------------------------------
// DOM helpers. Everything is built with createElement: titles and branch names come from GitLab
// and Notion and must never be parsed as HTML.

function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'style') Object.assign(node.style, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  return append(node, children);
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function s(tag, props = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(props)) {
    if (value !== null && value !== undefined && value !== false) node.setAttribute(key, value);
  }
  return append(node, children);
}

const ICONS = {
  check: 'M3 8.5l3.2 3.2L13 5',
  x: 'M4 4l8 8M12 4l-8 8',
  alert: 'M8 2.2l6.3 11H1.7L8 2.2zM8 6.6v3M8 11.5v.3',
  info: 'M8 1.8a6.2 6.2 0 100 12.4A6.2 6.2 0 008 1.8zM8 7.2v3.6M8 5v.3',
  branch:
    'M4 4.6v6.8M12 5.6c0 3.6-8 1.6-8 5.8M5.6 3a1.6 1.6 0 11-3.2 0 1.6 1.6 0 013.2 0zM5.6 13a1.6 1.6 0 11-3.2 0 1.6 1.6 0 013.2 0zM13.6 4a1.6 1.6 0 11-3.2 0 1.6 1.6 0 013.2 0z',
  merged:
    'M4 4.6v6.8M4 4.6c0 3.4 2.6 4.4 6.4 4.4M5.6 3a1.6 1.6 0 11-3.2 0 1.6 1.6 0 013.2 0zM5.6 13a1.6 1.6 0 11-3.2 0 1.6 1.6 0 013.2 0zM13.6 9a1.6 1.6 0 11-3.2 0 1.6 1.6 0 013.2 0z',
  external: 'M6.5 3.5h-3v9h9v-3M9.5 3.5h3v3M12.5 3.5L7.5 8.5',
  star: 'M8 2l1.8 3.7 4 .6-2.9 2.9.7 4L8 11.3 4.4 13.2l.7-4L2.2 6.3l4-.6L8 2z',
  theme: 'M8 2a6 6 0 100 12A6 6 0 008 2zM8 2v12',
};

function icon(name, title = null) {
  const svg = s('svg', { class: 'icon', viewBox: '0 0 16 16', 'aria-hidden': title ? null : 'true', role: title ? 'img' : null });
  if (title) svg.append(s('title', {}, title));
  if (name === 'dot') svg.append(s('circle', { cx: 8, cy: 8, r: 3.4, fill: 'currentColor', stroke: 'none' }));
  else svg.append(s('path', { d: ICONS[name] }));
  return svg;
}

const LEVEL_ICON = { error: 'x', warn: 'alert', info: 'info' };
const LEVEL_WORD = { error: 'Błąd', warn: 'Uwaga', info: 'Informacja' };

// ---------------------------------------------------------------------------------------------
// Formatting

const pad = (value) => String(value).padStart(2, '0');

function day(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  const text = `${pad(date.getDate())}.${pad(date.getMonth() + 1)}`;
  return date.getFullYear() === new Date().getFullYear() ? text : `${text}.${date.getFullYear()}`;
}
const clock = (iso) => {
  const date = new Date(iso);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const dayTime = (iso) => (iso ? `${day(iso)} ${clock(iso)}` : '');

function ago(iso) {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'przed chwilą';
  if (minutes < 60) return `${minutes} min temu`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} h temu`;
  return `${Math.round(minutes / 1440)} dni temu`;
}

function shortPerson(name) {
  const parts = String(name ?? '').trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts.at(-1)[0]}.` : (parts[0] ?? '');
}

/** Polish plural: `plural(3, 'gałąź', 'gałęzie', 'gałęzi')`. */
function plural(count, one, few, many) {
  const lastTwo = count % 100;
  const last = count % 10;
  if (count === 1) return one;
  return last >= 2 && last <= 4 && !(lastTwo >= 12 && lastTwo <= 14) ? few : many;
}

const MR_STATE = { opened: 'otwarty', merged: 'scalony', closed: 'zamknięty' };
const MERGE_STATUS = {
  mergeable: 'gotowy do scalenia',
  conflict: 'konflikt',
  need_rebase: 'wymaga rebase’u',
  discussions_not_resolved: 'nierozwiązane wątki',
  draft_status: 'draft',
  ci_must_pass: 'czeka na zielony pipeline',
  ci_still_running: 'pipeline w toku',
  not_approved: 'brak akceptacji',
  requested_changes: 'recenzent żąda zmian',
  blocked_status: 'zablokowany',
  checking: 'GitLab sprawdza',
  unchecked: 'jeszcze niesprawdzony',
  not_open: 'nie jest otwarty',
};
const PIPELINE = {
  success: ['check', 'pipe-success', 'zielony'],
  failed: ['x', 'pipe-failed', 'czerwony'],
  running: ['dot', 'pipe-running', 'w toku'],
  pending: ['dot', 'pipe-running', 'czeka'],
  created: ['dot', 'pipe-running', 'utworzony'],
};

// ---------------------------------------------------------------------------------------------
// State

const state = {
  model: null,
  status: null,
  tab: 'tickets',
  selected: null,
  query: '',
  showFinished: true,
  action: null,
  loadError: null,
  /** Version of the model on screen; the server's may be ahead while details are open. */
  shownVersion: null,
};

const el = {
  tabs: document.getElementById('tabs'),
  freshness: document.getElementById('freshness'),
  notices: document.getElementById('notices'),
  sidebar: document.getElementById('sidebar'),
  detail: document.getElementById('detail'),
  popovers: document.getElementById('popover-layer'),
  refresh: document.getElementById('refresh'),
  refreshNotion: document.getElementById('refresh-notion'),
  theme: document.getElementById('theme'),
};

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

function accept({ status, model }) {
  state.status = status;
  state.shownVersion = status.version;
  if (model) state.model = model;
  state.loadError = null;
  const tickets = state.model?.tickets ?? [];
  if (!tickets.some((ticket) => ticket.number === state.selected)) state.selected = tickets[0]?.number ?? null;
}

async function load() {
  try {
    accept(await fetchJson('/api/data'));
  } catch (error) {
    state.loadError = error.message;
  }
  render();
}

async function refresh(notion) {
  if (state.action) return;
  state.action = notion ? 'notion' : 'gitlab';
  renderFreshness();
  try {
    accept(await fetchJson(`/api/refresh${notion ? '?notion=1' : ''}`, { method: 'POST' }));
  } catch (error) {
    state.loadError = error.message;
  }
  state.action = null;
  render();
}

/**
 * The server refreshes in the background; the page notices through the version number. While the
 * tab stays in view the page also asks for a refresh once the data is older than the server's
 * limit, so a map left open all day does not go stale.
 */
async function poll() {
  let delay = 4000;
  if (!document.hidden) {
    try {
      const status = await fetchJson('/api/status');
      const changed = status.version !== state.shownVersion;
      state.status = status;
      // New data would close the details someone is reading; it waits until they are closed.
      if (changed && !state.action && !popoverOpen) await load();
      else {
        renderFreshness();
        renderNotices();
        if (!state.model) renderDetail();
      }
      const age = status.generatedAt ? Date.now() - Date.parse(status.generatedAt) : 0;
      const notionAge = status.notionFetchedAt ? Date.now() - Date.parse(status.notionFetchedAt) : 0;
      const stale = age > status.gitlabMaxAgeSeconds * 1000 || notionAge > status.notionMaxAgeMinutes * 60_000;
      // Reading the data is what makes the server check its age; the answer itself is not needed.
      if (stale && !status.busy && !state.action) fetchJson('/api/data').catch(() => {});
      if (status.busy) delay = 1000;
    } catch {
      /* the server may be restarting; keep polling */
    }
  }
  setTimeout(poll, delay);
}

// ---------------------------------------------------------------------------------------------
// Chrome: tabs, freshness, notices

function readHash() {
  const hash = decodeURIComponent(location.hash.slice(1));
  if (hash === 'wydania') state.tab = 'releases';
  else {
    state.tab = 'tickets';
    if (/^\d+$/.test(hash)) state.selected = Number(hash);
  }
}

function renderTabs() {
  const tab = (id, label, hash) =>
    h(
      'button',
      {
        class: 'tab',
        role: 'tab',
        type: 'button',
        'aria-selected': String(state.tab === id),
        onClick: () => {
          location.hash = hash;
        },
      },
      label,
    );
  const trouble = state.model ? chainTrouble(state.model) : 0;
  el.tabs.replaceChildren(
    tab('tickets', `Tickety${state.model ? ` (${state.model.tickets.length})` : ''}`, state.selected ? String(state.selected) : ''),
    tab('releases', ['Wydania i RC', trouble ? h('span', { class: 'tab-count', title: `${trouble} do sprawdzenia w gałęziach RC` }, icon('alert'), trouble) : null], 'wydania'),
  );
}

function renderFreshness() {
  const status = state.status;
  const parts = [];
  if (status?.busy || state.action) {
    parts.push(h('span', { class: 'busy' }, h('span', { class: 'spinner' }), status?.progress ?? 'Odświeżam'));
  }
  if (status?.generatedAt) {
    parts.push(h('span', { title: `Stan GitLaba odczytany ${dayTime(status.generatedAt)}` }, `GitLab: ${clock(status.generatedAt)}`));
  }
  if (status?.notionFetchedAt) {
    parts.push(
      h(
        'span',
        { title: `Tickety pobrane z Notion ${dayTime(status.notionFetchedAt)}; odświeżane co ${status.notionMaxAgeMinutes} min, gdy strona jest otwarta` },
        `Notion: ${ago(status.notionFetchedAt)}`,
      ),
    );
  }
  el.freshness.replaceChildren(...parts);
  const busy = Boolean(status?.busy || state.action);
  el.refresh.disabled = busy;
  el.refreshNotion.disabled = busy;
}

function renderNotices() {
  const notices = [];
  const notice = (kind, ...children) => h('div', { class: `notice ${kind}`, role: 'status' }, icon(kind === 'error' ? 'x' : 'alert'), h('div', {}, ...children));

  if (state.loadError) notices.push(notice('error', `Nie mogę połączyć się z lokalnym serwerem: ${state.loadError}`));
  if (state.status?.notionError) {
    notices.push(
      notice(
        'warn',
        h('b', {}, 'Notion: '),
        state.status.notionError.message,
        state.status.notionFetchedAt ? ` Pokazuję tickety pobrane ${ago(state.status.notionFetchedAt)}.` : '',
      ),
    );
  }
  if (state.status?.gitlabError) notices.push(notice('error', h('b', {}, 'GitLab: '), state.status.gitlabError.message));
  el.notices.replaceChildren(...notices);
}

// ---------------------------------------------------------------------------------------------
// Ticket list

function countsOf(ticket) {
  const { errors, warnings, open } = ticket.counts;
  const parts = [];
  if (errors) parts.push(h('span', { class: 'count error', title: `${errors} do naprawy` }, icon('x'), errors));
  if (warnings) parts.push(h('span', { class: 'count warn', title: `${warnings} do sprawdzenia` }, icon('alert'), warnings));
  if (!errors && !warnings && open) parts.push(h('span', { class: 'count ok', title: 'Otwarte MR-y celują tam, gdzie powinny' }, icon('check')));
  return h('span', { class: 'counts' }, parts);
}

function renderSidebar() {
  const tickets = state.model?.tickets ?? [];
  let search = el.sidebar.querySelector('.search');
  if (!search) {
    search = h('input', {
      class: 'search',
      type: 'search',
      placeholder: 'Szukaj: numer, tytuł, gałąź',
      'aria-label': 'Szukaj ticketu',
      onInput: (event) => {
        state.query = event.target.value.trim().toLowerCase();
        renderSidebar();
      },
    });
    el.sidebar.append(search, h('div', { class: 'ticket-list' }));
  }
  const list = el.sidebar.querySelector('.ticket-list');

  const matches = (ticket) => {
    if (!state.query) return true;
    const haystack = [
      `#${ticket.number}`,
      ticket.title,
      ticket.status,
      ...ticket.groups.flatMap((group) => group.lanes.flatMap((lane) => [lane.name, ...lane.items.map((item) => item.branch)])),
    ]
      .join(' ')
      .toLowerCase();
    return state.query.split(/\s+/).every((word) => haystack.includes(word));
  };

  const rows = [];
  let lastStatus = null;
  for (const ticket of tickets.filter(matches)) {
    if (ticket.status !== lastStatus) {
      lastStatus = ticket.status;
      rows.push(h('div', { class: 'status-heading' }, ticket.status ?? 'Bez statusu'));
    }
    const open = ticket.counts.open;
    const meta = [
      ticket.counts.items === 0
        ? 'brak gałęzi'
        : open
          ? `${open} ${plural(open, 'otwarty MR', 'otwarte MR-y', 'otwartych MR-ów')}`
          : 'wszystko scalone',
      ticket.roles.includes('qa') ? 'QA' : null,
      ticket.roles.includes('dev') ? 'dev' : null,
    ].filter(Boolean);
    rows.push(
      h(
        'button',
        {
          class: 'ticket',
          type: 'button',
          'aria-current': String(state.tab === 'tickets' && ticket.number === state.selected),
          onClick: () => {
            location.hash = String(ticket.number);
          },
        },
        h('div', { class: 'ticket-top' }, h('span', { class: 'ticket-number' }, `#${ticket.number}`), countsOf(ticket)),
        h('div', { class: 'ticket-title' }, ticket.title),
        h('div', { class: 'ticket-meta' }, meta.join(' · ')),
      ),
    );
  }
  if (tickets.length && rows.length === 0) rows.push(h('div', { class: 'ticket-meta', style: { padding: '8px' } }, 'Nic nie pasuje do wyszukiwania.'));
  list.replaceChildren(...rows);
}

// ---------------------------------------------------------------------------------------------
// Ticket view

function ticketHead(ticket) {
  const names = (people) => people.map((person) => person.name ?? 'ktoś').join(', ');
  const facts = [
    h('span', { class: 'pill strong' }, ticket.status ?? 'Bez statusu'),
    ticket.qaAssignees.length ? h('span', { class: 'fact' }, 'QA: ', h('b', {}, names(ticket.qaAssignees))) : null,
    ticket.assignees.length ? h('span', { class: 'fact' }, 'Dev: ', h('b', {}, names(ticket.assignees))) : null,
    ticket.qaAutomated ? h('span', { class: 'fact' }, 'Automatyzacja QA: ', h('b', {}, ticket.qaAutomated)) : null,
    ticket.priority ? h('span', { class: 'fact' }, 'Priorytet: ', h('b', {}, ticket.priority)) : null,
    ...ticket.releaseVersions
      .filter((version) => version.name)
      .map((version) => h('span', { class: 'pill', title: 'Wersja wydania wpisana w Notion' }, `Notion: ${version.name}`)),
    ticket.flag ? h('span', { class: 'pill' }, icon('alert'), ticket.flag) : null,
  ];
  const relatedLink = (label, other) =>
    h('a', { class: 'pill', href: other.url, target: '_blank', rel: 'noopener', title: other.title }, `${label} #${other.number}`, h('span', { class: 'muted' }, other.status ?? ''));

  return h(
    'div',
    { class: 'ticket-head' },
    h(
      'h2',
      {},
      h('span', { class: 'num' }, `#${ticket.number}`),
      h('a', { href: ticket.url, target: '_blank', rel: 'noopener', title: 'Otwórz w Notion' }, ticket.title),
    ),
    h('div', { class: 'facts' }, facts),
    ticket.parents.length || ticket.subtasks.length
      ? h(
          'div',
          { class: 'related' },
          ticket.parents.map((other) => relatedLink('Nadrzędny', other)),
          ticket.subtasks.map((other) => relatedLink('Podzadanie', other)),
        )
      : null,
  );
}

function findingRow(problem) {
  const where = problem.repoName ? `${problem.repoName}${problem.mrIid ? ` !${problem.mrIid}` : ''}` : null;
  const body = [
    icon(LEVEL_ICON[problem.level], LEVEL_WORD[problem.level]),
    h('span', {}, where ? h('span', { class: 'where' }, where) : null, problem.text),
  ];
  return h(
    'li',
    {},
    problem.itemKey
      ? h('button', { class: `finding ${problem.level}`, type: 'button', title: 'Pokaż na mapie', onClick: () => focusNode(problem.itemKey) }, body)
      : h('div', { class: `finding ${problem.level}` }, body),
  );
}

function findings(ticket) {
  const urgent = ticket.problems.filter((problem) => problem.level !== 'info');
  const notes = ticket.problems.filter((problem) => problem.level === 'info');
  if (ticket.problems.length === 0 && ticket.counts.items === 0) return null;

  let summary = null;
  if (urgent.length) summary = h('ul', {}, urgent.map(findingRow));
  else if (ticket.counts.open) {
    summary = h('div', { class: 'all-good' }, icon('check'), 'Nic nie wymaga poprawy: otwarte merge requesty celują tam, gdzie powinny.');
  }
  // With nothing urgent the notes are the whole story, so they are shown without a click.
  const noteList = h('ul', {}, notes.map(findingRow));
  return h(
    'section',
    { class: 'findings' },
    h('h3', {}, urgent.length ? `Do sprawdzenia (${urgent.length})` : 'Do sprawdzenia'),
    summary,
    notes.length ? (urgent.length ? h('details', {}, h('summary', {}, `Informacje (${notes.length})`), noteList) : noteList) : null,
  );
}

/** Says so when a sub-task has nothing of its own and the map shows its parent's branches. */
function borrowedNote(ticket) {
  const items = ticket.groups.flatMap((group) => group.lanes).flatMap((lane) => lane.items);
  if (items.length === 0 || items.some((item) => item.via.type === 'own' || item.via.type === 'alias')) return null;
  const sources = [...new Map(items.map((item) => [item.via.number, item.via])).values()];
  const names = sources.map((via) => `#${via.number}${via.title ? ` (${via.title})` : ''}`).join(', ');
  const kind = sources.every((via) => via.type === 'parent') ? 'ticketu nadrzędnego' : 'powiązanych ticketów';
  return h('p', { class: 'borrowed' }, `Żadna gałąź nie nosi numeru ${ticket.number}. Mapa pokazuje gałęzie ${kind} ${names}.`);
}

function legend(ticket, layout) {
  const sample = (className, marker) =>
    s('svg', { viewBox: '0 0 38 10', 'aria-hidden': 'true' }, s('path', { class: `edge ${className}`, d: 'M1,5 L31,5' }), s('path', { class: marker, d: 'M30,1 L37,5 L30,9 z' }));
  const finished = ticket.groups.flatMap((group) => group.lanes).flatMap((lane) => lane.items).filter((item) => !isLive(item)).length;
  return h(
    'div',
    { class: 'legend' },
    h('span', { class: 'legend-item' }, sample('open', 'arrow-open'), 'MR celuje w'),
    h('span', { class: 'legend-item' }, sample('expected', 'arrow-expected'), 'powinien celować w'),
    h('span', { class: 'legend-item' }, sample('warn', 'arrow-warn'), 'cel do poprawy'),
    h('span', { class: 'legend-item' }, sample('merged', 'arrow-merged'), 'scalony'),
    h('span', { class: 'legend-item' }, h('span', { class: 'trunk expected legend-trunk' }, icon('check')), 'właściwy cel'),
    h('span', { class: 'legend-item' }, icon('branch'), 'z czego wyszła gałąź, +własne −w plecy'),
    finished
      ? h(
          'label',
          { class: 'toggle' },
          h('input', {
            type: 'checkbox',
            checked: state.showFinished,
            onChange: (event) => {
              state.showFinished = event.target.checked;
              renderDetail();
            },
          }),
          `scalone i zamknięte (${finished})`,
          layout.hidden ? h('span', { class: 'muted' }, ` ukryte: ${layout.hidden}`) : null,
        )
      : null,
  );
}

function trunkTag(trunk) {
  if (trunk.kind === 'rc') {
    if (trunk.rcState === 'latest') return { text: 'najnowszy', icon: 'star' };
    if (trunk.rcState === 'open') return { text: 'otwarty' };
    if (trunk.rcState === 'absent') return { text: 'brak w repo' };
    if (trunk.rcState === 'leftover' || trunk.released) return { text: 'wydany' };
    return { text: 'usunięta', icon: 'x' };
  }
  if (trunk.kind === 'default') return { text: 'domyślna' };
  if (trunk.kind === 'candidate') return { text: 'pod wydanie' };
  if (trunk.kind === 'missing') return { text: 'usunięta' };
  return { text: 'gałąź' };
}

function trunkBox(box) {
  const { trunk } = box;
  const tag = trunkTag(trunk);
  const gone = !trunk.exists && trunk.targetedByOpen;
  const classes = [
    'trunk',
    trunk.expected ? 'expected' : '',
    gone ? 'gone' : !trunk.exists ? 'ghost' : '',
    trunk.released || trunk.rcState === 'leftover' ? 'past' : '',
  ].join(' ');
  const title = [
    trunk.ref,
    trunk.expected ? 'Tu powinny celować otwarte merge requesty z tego repozytorium.' : null,
    trunk.health ? `Uwaga: ${trunk.health.text}.` : null,
    trunk.note,
    trunk.committedAt ? `Ostatni commit ${dayTime(trunk.committedAt)}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  const content = [
    h('span', { class: 'trunk-name' }, trunk.label),
    h(
      'span',
      { class: 'trunk-tag' },
      trunk.health ? h('span', { class: `health ${trunk.health.level}` }, icon('alert', trunk.health.text)) : null,
      trunk.expected ? icon('check', 'właściwy cel') : tag.icon ? icon(tag.icon) : null,
      tag.text,
    ),
  ];
  const position = { left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px` };
  return trunk.webUrl
    ? h('a', { class: classes, style: position, href: trunk.webUrl, target: '_blank', rel: 'noopener', title }, content)
    : h('div', { class: classes, style: position, title }, content);
}

function chipEl(chip) {
  return h('span', { class: `chip ${chip.level}` }, chip.level === 'error' ? icon('x') : chip.level === 'warn' ? icon('alert') : null, chip.text);
}

function pipelineEl(mr) {
  if (!mr?.pipeline) return null;
  const [name, className, word] = PIPELINE[mr.pipeline.status] ?? ['dot', '', mr.pipeline.status];
  return h('span', { class: className, title: `Pipeline: ${word}` }, icon(name, `Pipeline: ${word}`));
}

function originEl(item) {
  if (!item.base) return null;
  const { base } = item;
  const title = `Wyszła z ${base.label}: ${base.ahead}${base.aheadCapped ? '+' : ''} własnych commitów, ${base.behind}${base.behindCapped ? '+' : ''} w plecy${base.fromLocalRefs ? ' (wg lokalnych refów)' : ''}`;
  return h(
    'span',
    { class: 'origin', title },
    icon('branch'),
    'z ',
    h('b', {}, base.label),
    h('span', { class: 'delta' }, `+${base.ahead}${base.aheadCapped ? '+' : ''} −${base.behind}${base.behindCapped ? '+' : ''}`),
  );
}

function nodeBox(node) {
  const { item } = node;
  const level = item.flags.some((flag) => flag.level === 'error') ? 'error' : item.flags.some((flag) => flag.level === 'warn') ? 'warn' : '';
  const position = { left: `${node.x}px`, top: `${node.y}px`, width: `${node.width}px`, height: `${node.height}px` };
  const common = {
    type: 'button',
    style: position,
    'data-key': item.key,
    'aria-expanded': 'false',
    onClick: (event) => openPopover(node, event.currentTarget),
    onMouseenter: () => highlight(item.key),
    onMouseleave: () => highlight(null),
    onFocus: () => highlight(item.key),
    onBlur: () => highlight(null),
  };

  if (node.compact) {
    const when = item.mr?.mergedAt ?? item.mr?.closedAt ?? item.mr?.updatedAt;
    const tags = node.chips.filter((chip) => chip.level === 'env' || chip.level === 'via');
    return h(
      'button',
      { ...common, class: 'node compact', title: `${item.branch}\n${item.outcome?.text ? `Zmiany: ${item.outcome.text}` : MR_STATE[item.mr.state]}` },
      h('span', { class: 'state-icon' }, icon(item.mr.state === 'merged' ? 'merged' : 'x', MR_STATE[item.mr.state])),
      h('span', { class: 'branch-name' }, item.branch),
      h('span', { class: 'end' }, tags.map(chipEl), day(when)),
    );
  }

  const who = item.mr ? `${shortPerson(item.mr.author.name)} · ${day(item.mr.updatedAt)}` : day(item.committedAt);
  return h(
    'button',
    { ...common, class: `node live ${level ? `level-${level}` : ''}`, title: item.branch },
    h('div', { class: 'node-row' }, h('span', { class: 'branch-name' }, item.branch), h('span', { class: 'end' }, pipelineEl(item.mr))),
    h('div', { class: 'node-row' }, originEl(item), h('span', { class: 'end' }, who)),
    node.chips.length ? h('div', { class: 'chips' }, node.chips.map(chipEl)) : null,
  );
}

function edgeLabel(edge) {
  const position = { left: `${edge.label.x}px`, top: `${edge.label.y}px` };
  if (edge.kind === 'expected') {
    return h('span', { class: 'edge-label expected', style: position, 'data-key': edge.item.key, title: 'Tu powinien celować merge request' }, 'powinien');
  }
  const { mr } = edge.item;
  const word = mr.state === 'opened' && mr.draft ? 'draft' : MR_STATE[mr.state];
  return h(
    'a',
    {
      class: `edge-label ${edge.style}`,
      style: position,
      'data-key': edge.item.key,
      href: mr.webUrl,
      target: '_blank',
      rel: 'noopener',
      title: `${mr.title}\n${word} → ${edge.item.target?.label ?? mr.targetRef}`,
    },
    edge.style === 'error' ? icon('x', 'błędny cel') : edge.style === 'warn' ? icon('alert', 'cel do poprawy') : null,
    h('span', { class: 'iid' }, `!${mr.iid}`),
    h('span', { class: 'state' }, word),
  );
}

function laneBand(band, layout) {
  const { lane } = band;
  const note =
    lane.role === 'product'
      ? lane.released
        ? `wydane ${lane.released.version}${lane.released.source === 'merge' ? ' · bez tagu' : ''}`
        : 'bez wydań'
      : lane.role === 'qa'
        ? 'testy E2E'
        : lane.role === 'library'
          ? 'biblioteka'
          : '';
  const noteTitle =
    lane.released?.source === 'merge'
      ? `Wersja ${lane.released.version} jest scalona do ${lane.defaultBranch} (${day(lane.released.at)}), tag jeszcze nie powstał.`
      : lane.released
        ? `Ostatni tag: v${lane.released.version} (${day(lane.released.at)})`
        : null;
  return h(
    'div',
    { class: 'band lane', style: { top: `${band.y}px`, height: `${band.height}px` } },
    h(
      'div',
      { class: 'lane-label', style: { width: `${layout.labelW - 16}px` } },
      h('a', { class: 'repo', href: lane.webUrl, target: '_blank', rel: 'noopener' }, lane.name),
      note ? h('div', { class: 'lane-note', title: noteTitle }, note) : null,
    ),
  );
}

function groupBand(band, ticket) {
  const { group } = band;
  const notes = [];
  if (group.openVersions) {
    notes.push(group.openVersions.length ? `otwarte RC: ${group.openVersions.join(', ')}` : 'brak otwartego RC');
  }
  const planned = ticket.releaseVersions.find((version) => version.product === group.key && version.version);
  if (planned) notes.push(`plan w Notion: ${planned.version}`);
  return h(
    'div',
    { class: 'band group', style: { top: `${band.y}px`, height: `${band.height}px` } },
    h('span', { class: 'group-name' }, group.label),
    h('span', { class: 'group-note' }, notes.join(' · ')),
  );
}

function arrowMarkers() {
  const marker = (name) =>
    s(
      'marker',
      { id: `arrow-${name}`, viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 8, markerHeight: 8, orient: 'auto-start-reverse' },
      s('path', { d: 'M0,0.6 L7.4,4 L0,7.4 z', class: `arrow-${name}` }),
    );
  return s('defs', {}, ['open', 'merged', 'warn', 'error', 'expected'].map(marker));
}

const MARKER_OF = { open: 'open', draft: 'open', merged: 'merged', closed: 'merged', warn: 'warn', error: 'error', expected: 'expected' };

function graph(ticket, layout) {
  if (layout.nodes.length === 0) {
    return h(
      'div',
      { class: 'graph-scroll' },
      h('div', { class: 'empty-map' }, ticket.counts.items ? 'Wszystkie gałęzie tego ticketu są scalone lub zamknięte. Zaznacz „scalone i zamknięte”, żeby je zobaczyć.' : 'Nie ma jeszcze czego rysować: żadna gałąź ani merge request nie nosi numeru tego ticketu.'),
    );
  }
  // The legend's samples are painted before the map, so the map owns the arrowheads.
  const edges = s('svg', { class: 'edges', width: layout.width, height: layout.height, 'aria-hidden': 'true' }, arrowMarkers());
  // Finished history is drawn first so that live lines stay on top of it.
  const order = { merged: 0, closed: 0, expected: 1, open: 2, draft: 2, warn: 3, error: 3 };
  for (const edge of [...layout.edges].sort((a, b) => order[a.style] - order[b.style])) {
    edges.append(
      s('path', {
        class: `edge ${edge.style}`,
        d: edge.path,
        'marker-end': `url(#arrow-${MARKER_OF[edge.style]})`,
        'data-key': edge.item.key,
      }),
    );
  }
  return h(
    'div',
    { class: 'graph-scroll' },
    h(
      'div',
      {
        class: 'graph',
        style: { width: `${layout.width}px`, height: `${layout.height}px` },
        role: 'group',
        'aria-label': `Mapa gałęzi ticketu ${ticket.number}`,
      },
      layout.bands.map((band) => (band.type === 'group' ? groupBand(band, ticket) : laneBand(band, layout))),
      edges,
      layout.trunks.map(trunkBox),
      layout.nodes.map(nodeBox),
      layout.edges.map(edgeLabel),
    ),
  );
}

function highlight(key) {
  const root = el.detail.querySelector('.graph');
  if (!root) return;
  root.classList.toggle('dim', Boolean(key));
  for (const node of root.querySelectorAll('.edge, .edge-label')) node.classList.toggle('hl', Boolean(key) && node.dataset.key === key);
}

function focusNode(key) {
  let node = el.detail.querySelector(`.node[data-key="${CSS.escape(key)}"]`);
  if (!node && !state.showFinished) {
    state.showFinished = true;
    renderDetail();
    node = el.detail.querySelector(`.node[data-key="${CSS.escape(key)}"]`);
  }
  if (!node) return;
  node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
  node.classList.remove('flash');
  void node.offsetWidth;
  node.classList.add('flash');
  node.focus({ preventScroll: true });
}

// ---------------------------------------------------------------------------------------------
// Details of one branch

let closePopover = () => {};
let popoverOpen = false;

function popoverContent(node) {
  const { item, lane } = node;
  const { mr } = item;
  const rows = [];
  const row = (label, ...value) => rows.push(h('dt', {}, label), h('dd', {}, ...value));

  if (mr) {
    row('Stan', mr.state === 'opened' && mr.draft ? 'draft' : MR_STATE[mr.state], mr.mergedAt ? `, ${dayTime(mr.mergedAt)}` : '');
    row('Autor', mr.author.name ?? mr.author.username ?? '');
    row('Cel', h('span', { class: 'mono' }, mr.targetRef), item.target && !item.target.exists ? ' (gałęzi nie ma w repozytorium)' : '');
    if (item.expected && item.expected.reason !== 'stack' && item.expected.ref !== mr.targetRef) {
      row('Powinien', h('span', { class: 'mono' }, item.expected.ref));
    }
    if (item.outcome) row('Zmiany', item.outcome.text);
    if (mr.state === 'opened') {
      row('Scalanie', MERGE_STATUS[mr.mergeStatus] ?? mr.mergeStatus ?? '', mr.mergeStatus ? h('span', { class: 'muted mono' }, ` ${mr.mergeStatus}`) : '');
      if (mr.pipeline) {
        row('Pipeline', h('a', { href: mr.pipeline.webUrl, target: '_blank', rel: 'noopener' }, (PIPELINE[mr.pipeline.status] ?? [])[2] ?? mr.pipeline.status));
      }
      row('Aktualizacja', dayTime(mr.updatedAt));
    }
  } else {
    row('Merge request', 'brak');
    if (item.expected) row('Cel MR-a', h('span', { class: 'mono' }, item.expected.ref));
    if (item.committedAt) row('Ostatni commit', dayTime(item.committedAt));
  }
  if (item.via.type !== 'own') {
    const how = { parent: 'ticket nadrzędny', subtask: 'podzadanie', alias: 'dawny numer' }[item.via.type];
    row('Skąd', `${how} #${item.via.number}${item.via.title ? `: ${item.via.title}` : ''}`);
  }
  if (item.local) {
    const text = {
      synced: 'zgodna z origin',
      ahead: `${item.local.ahead} commitów do wypchnięcia`,
      behind: `${item.local.behind} commitów za origin`,
      diverged: `rozjechana z origin (+${item.local.ahead} −${item.local.behind})`,
      'local-only': 'istnieje tylko lokalnie',
      'remote-gone': 'na origin już usunięta, została lokalna kopia',
      unknown: 'różni się od origin (zrób fetch, żeby policzyć)',
    }[item.local.state];
    row('Lokalnie', text, item.local.current ? ', aktualny checkout' : '');
  }
  for (const deployment of lane.deployments.filter((entry) => entry.item === item.key)) {
    row(envLabel(deployment.environment), `wdrożone ${dayTime(deployment.at)}`, deployment.upToDate === false ? ' ze starszego commita niż obecny' : '');
  }

  const relations = item.relations.length
    ? [
        h('h5', {}, 'Odległość od innych gałęzi'),
        h(
          'table',
          {},
          h('thead', {}, h('tr', {}, h('th', {}, 'względem'), h('th', { class: 'num' }, 'własne'), h('th', { class: 'num' }, 'w plecy'), h('th', {}, ''))),
          h(
            'tbody',
            {},
            item.relations.map((relation) =>
              h(
                'tr',
                {},
                h('td', { class: 'mono' }, relation.label),
                h('td', { class: 'num' }, `+${relation.ahead}${relation.aheadCapped ? '+' : ''}`),
                h('td', { class: 'num' }, `−${relation.behind}${relation.behindCapped ? '+' : ''}`),
                h(
                  'td',
                  {},
                  h(
                    'div',
                    { class: 'roles' },
                    relation.isBase ? h('span', { class: 'chip' }, 'wyszła stąd') : null,
                    relation.isTarget ? h('span', { class: 'chip' }, 'cel') : null,
                    relation.isExpected ? h('span', { class: 'chip' }, 'powinien') : null,
                  ),
                ),
              ),
            ),
          ),
        ),
      ]
    : [];

  const flags = item.flags.length
    ? [
        h('h5', {}, 'Ustalenia'),
        h(
          'ul',
          { class: 'flags' },
          item.flags.map((flag) => h('li', { class: `finding ${flag.level}`, style: { padding: 0 } }, icon(LEVEL_ICON[flag.level], LEVEL_WORD[flag.level]), h('span', {}, flag.text))),
        ),
      ]
    : [];

  const others = item.otherMrs.length
    ? [
        h('h5', {}, 'Wcześniejsze merge requesty tej gałęzi'),
        h(
          'ul',
          { class: 'flags' },
          item.otherMrs.map((other) =>
            h('li', {}, h('a', { href: other.webUrl, target: '_blank', rel: 'noopener' }, `!${other.iid}`), ` ${MR_STATE[other.state]} → `, h('span', { class: 'mono' }, other.targetRef)),
          ),
        ),
      ]
    : [];

  return [
    h('h4', {}, item.branch),
    mr ? h('div', { class: 'mr-title' }, mr.title) : null,
    h(
      'div',
      { class: 'links' },
      mr ? h('a', { href: mr.webUrl, target: '_blank', rel: 'noopener' }, `MR !${mr.iid}`, icon('external')) : null,
      item.branchUrl ? h('a', { href: item.branchUrl, target: '_blank', rel: 'noopener' }, 'gałąź', icon('external')) : null,
      h('a', { href: lane.webUrl, target: '_blank', rel: 'noopener' }, lane.name, icon('external')),
    ),
    h('dl', {}, rows),
    relations,
    flags,
    others,
  ];
}

/** Shows `content` in a floating panel next to `anchor`; one panel at a time. */
function showPopover(anchor, content, label) {
  closePopover();
  const popover = h(
    'div',
    { class: 'popover', role: 'dialog', 'aria-label': label },
    h('button', { class: 'close', type: 'button', 'aria-label': 'Zamknij', onClick: () => closePopover() }, icon('x')),
    content,
  );
  el.popovers.append(popover);
  anchor.setAttribute('aria-expanded', 'true');
  popoverOpen = true;

  const rect = anchor.getBoundingClientRect();
  const box = popover.getBoundingClientRect();
  const margin = 12;
  const left = Math.max(margin, Math.min(rect.left, window.innerWidth - box.width - margin));
  const below = rect.bottom + 8;
  const top = below + box.height + margin <= window.innerHeight ? below : Math.max(margin, rect.top - box.height - 8);
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;

  const onKey = (event) => event.key === 'Escape' && closePopover();
  const onDown = (event) => !popover.contains(event.target) && !anchor.contains(event.target) && closePopover();
  const onScroll = (event) => !popover.contains(event.target) && closePopover();
  document.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', onDown);
  document.addEventListener('scroll', onScroll, true);
  closePopover = () => {
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('pointerdown', onDown);
    document.removeEventListener('scroll', onScroll, true);
    popover.remove();
    anchor.setAttribute('aria-expanded', 'false');
    popoverOpen = false;
    closePopover = () => {};
  };
}

const openPopover = (node, anchor) => showPopover(anchor, popoverContent(node), `Szczegóły gałęzi ${node.item.branch}`);

// ---------------------------------------------------------------------------------------------
// Releases view

const LINK_ICON = { ok: 'check', warn: 'alert', error: 'x', info: 'info' };

/** Compares `1.15.0` with `1.9.2` as versions, not as text. */
function compareVersionText(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

function commitList(commitsToShow, total) {
  if (!commitsToShow.length) return null;
  return [
    h(
      'ul',
      { class: 'commit-list' },
      commitsToShow.map((commit) =>
        h('li', {}, h('span', { class: 'mono muted' }, commit.id), ' ', commit.title, h('span', { class: 'muted' }, ` · ${shortPerson(commit.author)}${commit.at ? `, ${day(commit.at)}` : ''}`)),
      ),
    ),
    total > commitsToShow.length ? h('div', { class: 'muted' }, `i ${total - commitsToShow.length} więcej`) : null,
  ];
}

/** Details behind one link of the chain: what exactly the later branch lacks. */
function relationDetails(candidate, relation) {
  const rows = [];
  const row = (label, ...value) => rows.push(h('dt', {}, label), h('dd', {}, ...value));
  row('Zawiera wszystko', relation.status === 'contains' ? 'tak' : 'nie');
  if (relation.behind) row(`Commity z ${relation.baseLabel}, których tu nie ma`, `${relation.behind}${relation.behindCapped ? '+' : ''}`);
  if (relation.rewritten) row('z tego kopie sprzed rebase’u', String(relation.rewritten));
  row(`Własne ponad ${relation.baseLabel}`, `${relation.ahead}${relation.aheadCapped ? '+' : ''}`);
  return [
    h('h4', {}, `${candidate.label} względem ${relation.baseLabel}`),
    h('div', { class: 'mr-title' }, `${candidate.label}: ${relation.text}.`),
    h('div', { class: 'links' }, h('a', { href: relation.compareUrl, target: '_blank', rel: 'noopener' }, 'porównaj w GitLabie', icon('external'))),
    h('dl', {}, rows),
    relation.missing.length ? [h('h5', {}, `Brakujące commity z ${relation.baseLabel}`), commitList(relation.missing, relation.missingCount)] : null,
    relation.approximate ? h('p', { class: 'muted' }, 'Po którejś stronie jest ponad 100 commitów, więc liczby są dolnym oszacowaniem.') : null,
  ];
}

function candidateDetails(candidate, chain) {
  const rows = [];
  const row = (label, ...value) => rows.push(h('dt', {}, label), h('dd', {}, ...value));
  row('Ostatni commit', dayTime(candidate.committedAt));
  if (candidate.toDefault) row(`Względem ${chain.defaultBranch}`, candidate.toDefault.text);
  if (candidate.toPrevious) row(`Względem ${candidate.toPrevious.baseLabel}`, candidate.toPrevious.text);
  if (candidate.unreleased) row(`Czy ${chain.defaultBranch} to ma`, candidate.unreleased.text);
  return [
    h('h4', {}, candidate.name),
    h(
      'div',
      { class: 'links' },
      h('a', { href: candidate.webUrl, target: '_blank', rel: 'noopener' }, 'gałąź', icon('external')),
      candidate.toDefault ? h('a', { href: candidate.toDefault.compareUrl, target: '_blank', rel: 'noopener' }, `różnica względem ${chain.defaultBranch}`, icon('external')) : null,
    ),
    h('dl', {}, rows),
  ];
}

function chainLink(candidate, relation) {
  return h(
    'span',
    { class: `chain-seg ${relation.level}` },
    h('span', { class: 'chain-line' }),
    h(
      'button',
      {
        class: 'chain-link',
        type: 'button',
        'aria-expanded': 'false',
        title: 'Pokaż szczegóły',
        onClick: (event) => showPopover(event.currentTarget, relationDetails(candidate, relation), `${candidate.label} względem ${relation.baseLabel}`),
      },
      icon(LINK_ICON[relation.level]),
      relation.text,
    ),
    h('span', { class: 'chain-line arrow' }),
  );
}

function chainNode(candidate, chain) {
  const ahead = candidate.toDefault ? `${candidate.toDefault.ahead}${candidate.toDefault.aheadCapped ? '+' : ''}` : '?';
  // The answer to "does the default branch have what this candidate has".
  const sub = candidate.leftover
    ? 'pozostałość po wydaniu'
    : candidate.toDefault?.ahead === 0
      ? `${chain.defaultBranch} ma wszystko`
      : candidate.sameContentAsDefault
        ? `${chain.defaultBranch} ma tę samą treść`
        : `+${ahead} nie ma jeszcze w ${chain.defaultBranch}`;
  // On a later candidate the link in front of it speaks about the candidate before; the default
  // branch gets its own mark when something of it is missing too.
  const alsoBehindDefault = candidate.toPrevious && candidate.toDefault && candidate.toDefault.level !== 'ok';
  return h(
    'button',
    {
      class: `chain-node ${candidate.latest ? 'latest' : ''} ${candidate.leftover ? 'leftover' : ''}`,
      type: 'button',
      'aria-expanded': 'false',
      title: 'Pokaż szczegóły',
      onClick: (event) => showPopover(event.currentTarget, candidateDetails(candidate, chain), `Szczegóły ${candidate.label}`),
    },
    h('span', { class: 'name' }, candidate.label, candidate.latest ? icon('star', 'najnowszy RC') : null),
    h('span', { class: 'sub' }, alsoBehindDefault ? h('span', { class: `health ${candidate.toDefault.level}` }, icon('alert'), ` ${candidate.toDefault.text} · `) : null, sub),
  );
}

function chainRow(repo, product) {
  const chain = repo.rcChain;
  const missingVersions = product.openVersions.filter((version) => !chain.open.some((candidate) => candidate.version === version));
  const parts = [h('a', { class: 'chain-node base', href: chain.defaultUrl, target: '_blank', rel: 'noopener' }, h('span', { class: 'name' }, chain.defaultBranch), h('span', { class: 'sub' }, 'domyślna'))];
  for (const candidate of chain.open) {
    const relation = candidate.toPrevious ?? candidate.toDefault;
    if (relation) parts.push(chainLink(candidate, relation));
    parts.push(chainNode(candidate, chain));
  }
  if (chain.open.length === 0) parts.push(h('span', { class: 'chain-note' }, 'brak otwartej gałęzi RC'));
  for (const version of missingVersions) {
    // A version this repository has already shipped is not missing here; its branch is just gone.
    const shipped = repo.released && compareVersionText(version, repo.released.version) <= 0;
    parts.push(
      h(
        'span',
        {
          class: 'chain-node ghost',
          title: shipped
            ? `To repozytorium scaliło już ${version} do ${chain.defaultBranch}; w innych repozytoriach produktu ta wersja jest jeszcze otwarta.`
            : `Inne repozytoria tego produktu mają już release-candidate/${version}.`,
        },
        h('span', { class: 'name' }, `RC ${version}`),
        h('span', { class: 'sub' }, shipped ? 'tutaj już wydany' : 'brak w tym repo'),
      ),
    );
  }
  return h(
    'div',
    { class: 'chain-row' },
    h(
      'div',
      { class: 'chain-repo' },
      h('a', { href: repo.webUrl, target: '_blank', rel: 'noopener' }, h('b', {}, repo.name)),
      h('div', { class: 'muted' }, repo.released ? `wydane ${repo.released.version}${repo.released.source === 'merge' ? ' · bez tagu' : ''}` : 'bez wydań'),
    ),
    h('div', { class: 'chain' }, parts, chain.leftovers.length ? h('span', { class: 'chain-leftovers' }, chain.leftovers.map((candidate) => chainNode(candidate, chain))) : null),
  );
}

/** How many links of the candidate chains need attention; shown on the tab. */
function chainTrouble(model) {
  return model.repos
    .flatMap((repo) => repo.rcChain?.open ?? [])
    .flatMap((candidate) => [candidate.toDefault, candidate.toPrevious])
    .filter((relation) => relation && relation.level !== 'ok').length;
}

function releasesView(model) {
  const deployCell = (repo, environment) => {
    const deployment = repo.deployments[environment];
    if (!deployment) return h('td', { class: 'muted' }, '–');
    const what = (deployment.mrIid ? `!${deployment.mrIid}${deployment.mr ? ` ${deployment.mr.sourceBranch}` : ''}` : deployment.ref).replace('release-candidate/', 'RC ');
    return h(
      'td',
      { class: 'deploy', title: [what, deployment.mr?.title, deployment.by].filter(Boolean).join('\n') },
      deployment.mr?.webUrl
        ? h('a', { class: 'what mono', href: deployment.mr.webUrl, target: '_blank', rel: 'noopener' }, what)
        : h('span', { class: 'what mono' }, what),
      h('span', { class: 'when' }, dayTime(deployment.at)),
    );
  };

  const cards = model.products.map((product) => {
    const repos = product.repos.map((repoPath) => model.repos.find((repo) => repo.path === repoPath)).filter(Boolean);
    return h(
      'section',
      { class: 'product-card' },
      h(
        'header',
        {},
        h('h3', {}, product.label),
        h('span', { class: 'muted' }, `ostatni tag ${product.tagVersion ?? '–'} · otwarte RC: ${product.openVersions.length ? product.openVersions.join(', ') : 'brak'}`),
      ),
      h('div', { class: 'chains' }, repos.filter((repo) => repo.rcChain).map((repo) => chainRow(repo, product))),
      h(
        'table',
        {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Wdrożone'), h('th', {}, 'STG'), h('th', {}, 'preprod'), h('th', {}, 'UAT'))),
        h(
          'tbody',
          {},
          repos
            .filter((repo) => Object.keys(repo.deployments).length)
            .map((repo) => h('tr', {}, h('td', {}, h('b', {}, repo.name)), deployCell(repo, 'stg'), deployCell(repo, 'preprod'), deployCell(repo, 'uat'))),
        ),
      ),
    );
  });

  return h(
    'div',
    { class: 'releases' },
    h('h2', {}, 'Wydania i release candidates'),
    h(
      'p',
      { class: 'lead' },
      'Każdy wiersz to łańcuch jednego repozytorium: gałąź domyślna, potem otwarte gałęzie ',
      h('span', { class: 'mono' }, 'release-candidate/*'),
      ' od najstarszej do najnowszej. Etykieta na strzałce mówi, czy gałąź po prawej zawiera wszystko z tej po lewej, czyli czy jest po rebase. Pod nazwą RC widać, ile commitów czeka w nim na wydanie. Kliknij etykietę albo gałąź, żeby zobaczyć brakujące commity.',
    ),
    cards,
  );
}

// ---------------------------------------------------------------------------------------------
// Main render

function placeholder() {
  const status = state.status;
  if (status?.notionError && !state.model) {
    return h('div', { class: 'placeholder' }, h('h2', {}, 'Nie mam jeszcze listy ticketów'), h('p', {}, status.notionError.message));
  }
  if (state.loadError && !state.model) {
    return h('div', { class: 'placeholder' }, h('h2', {}, 'Brak połączenia z serwerem'), h('p', {}, state.loadError));
  }
  return h(
    'div',
    { class: 'placeholder' },
    h('span', { class: 'spinner' }),
    h('h2', {}, 'Czytam Notion i GitLaba'),
    h('p', {}, status?.progress ?? 'Pierwsze wczytanie trwa kilkanaście sekund; kolejne odświeżają się w tle.'),
  );
}

function renderDetail() {
  closePopover();
  const scroll = { top: el.detail.scrollTop, left: el.detail.scrollLeft };
  const model = state.model;
  let content;
  if (!model) content = placeholder();
  else if (state.tab === 'releases') content = releasesView(model);
  else {
    const ticket = model.tickets.find((entry) => entry.number === state.selected);
    if (!ticket) {
      content = h(
        'div',
        { class: 'placeholder' },
        h('h2', {}, 'Brak ticketów'),
        h('p', {}, 'W Notion nie ma teraz niewydanego ticketu przypisanego do Ciebie jako Assignee ani QA assignee.'),
      );
    } else {
      // 40px of padding and 2px of border surround the map inside the detail pane.
      const layout = layoutTicket(ticket, { showFinished: state.showFinished, availableWidth: el.detail.clientWidth - 42 });
      content = h(
        'div',
        { class: 'ticket-view' },
        ticketHead(ticket),
        findings(ticket),
        borrowedNote(ticket),
        legend(ticket, layout),
        graph(ticket, layout),
        model.warnings.length
          ? h('details', { class: 'warnings' }, h('summary', {}, `Uwagi do odczytu danych (${model.warnings.length})`), h('ul', {}, model.warnings.map((warning) => h('li', {}, warning))))
          : null,
      );
    }
  }
  const sameView = el.detail.dataset.view === `${state.tab}:${state.selected}`;
  el.detail.dataset.view = `${state.tab}:${state.selected}`;
  el.detail.replaceChildren(content);
  el.detail.scrollTop = sameView ? scroll.top : 0;
  el.detail.scrollLeft = sameView ? scroll.left : 0;
}

function render() {
  renderTabs();
  renderFreshness();
  renderNotices();
  renderSidebar();
  renderDetail();
}

// ---------------------------------------------------------------------------------------------
// Start

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

let storedTheme = null;
try {
  storedTheme = localStorage.getItem('theme');
} catch {
  /* private mode: follow the system */
}
applyTheme(storedTheme);
el.theme.append(icon('theme'));
el.theme.addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : window.matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  applyTheme(next);
  try {
    localStorage.setItem('theme', next);
  } catch {
    /* not stored; the choice lasts until the page is closed */
  }
});

el.refresh.addEventListener('click', () => refresh(false));
el.refreshNotion.addEventListener('click', () => refresh(true));
window.addEventListener('hashchange', () => {
  readHash();
  render();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) load();
});
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderDetail, 120);
});

readHash();
render();
await load();
if (state.selected && !location.hash) history.replaceState(null, '', `#${state.selected}`);
poll();
