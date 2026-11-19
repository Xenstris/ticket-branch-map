#!/usr/bin/env node
/**
 * Local server for the ticket branch map. Serves the page and one JSON model; listens on
 * 127.0.0.1 only, because the model is internal data and there is no authentication.
 *
 *   node server.mjs [--no-open] [--no-notion]
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { watchedChangeSince } from './lib/changes.mjs';
import { buildModel } from './lib/collect.mjs';
import { GitLab } from './lib/gitlab.mjs';
import { readSnapshot, refreshNotion } from './lib/notion.mjs';
import { DiskCache } from './lib/util.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(root, 'data');
const publicDir = path.join(root, 'public');
const config = JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8'));
const port = Number(process.env.PORT ?? config.port ?? 4455);

await fs.mkdir(dataDir, { recursive: true });
const gitlab = new GitLab({ hostname: config.gitlab.hostname, concurrency: config.gitlab.concurrency });
const cache = await new DiskCache(path.join(dataDir, 'cache.json'), { fs }).load();

const state = {
  /** Bumped whenever a new model is ready; the page polls it. */
  version: 0,
  model: null,
  modelAt: 0,
  snapshot: await readSnapshot(dataDir),
  job: null,
  queued: null,
  progress: null,
  notionError: null,
  gitlabError: null,
};

/** `--no-notion`: ask Notion only when the button is pressed (or when there are no tickets yet). */
const autoNotion = !process.argv.includes('--no-notion');
const notionStale = () =>
  !state.snapshot || (autoNotion && Date.now() - Date.parse(state.snapshot.fetchedAt) > config.notion.maxAgeMinutes * 60_000);
const gitlabStale = () => !state.model || Date.now() - state.modelAt > config.gitlab.maxAgeSeconds * 1000;

/**
 * Rebuilds the model, first asking Notion for the tickets when `notion` is set. One job runs at
 * a time; a request that arrives meanwhile and needs more than the running job is queued.
 */
function refresh({ notion = false } = {}) {
  if (state.job) {
    if (notion && !state.job.notion) state.queued = { notion: true };
    return state.job.promise;
  }

  const run = async () => {
    try {
      if (notion || !state.snapshot) {
        try {
          state.snapshot = await refreshNotion({
            notionConfig: config.notion,
            dataDir,
            previous: state.snapshot,
            onProgress: (text) => (state.progress = text),
          });
          state.notionError = null;
        } catch (error) {
          state.notionError = { message: error.message, kind: error.kind ?? 'failed', at: new Date().toISOString() };
          if (!state.snapshot) return;
        }
      }
      try {
        state.progress = 'GitLab: start';
        state.model = await buildModel({
          config,
          snapshot: state.snapshot,
          gitlab,
          cache,
          onProgress: (text) => (state.progress = text),
        });
        state.modelAt = Date.now();
        state.gitlabError = null;
        state.version += 1;
        await cache.save().catch(() => {});
      } catch (error) {
        state.gitlabError = { message: error.message, at: new Date().toISOString() };
      }
    } finally {
      state.job = null;
      state.progress = null;
      if (state.queued) {
        const next = state.queued;
        state.queued = null;
        refresh(next);
      }
    }
  };

  state.job = { notion: notion || !state.snapshot, promise: null };
  state.job.promise = run();
  return state.job.promise;
}

/**
 * A full rebuild reads about a hundred endpoints, so it runs every couple of minutes. Between
 * rebuilds one request asks whether any merge request on the map changed (a new target, a push,
 * a merge), and a change starts a rebuild right away.
 */
const changeCheck = { at: 0, running: false };
async function checkForChanges() {
  if (!state.model || state.job || changeCheck.running) return;
  if (Date.now() - changeCheck.at < (config.gitlab.changeCheckSeconds ?? 15) * 1000) return;
  changeCheck.running = true;
  changeCheck.at = Date.now();
  try {
    const changed = await watchedChangeSince(gitlab, {
      groupId: config.gitlab.groupId,
      newest: state.model.newestMergeRequestUpdate,
      watchedPaths: state.model.repos.map((repo) => repo.path),
    });
    if (changed && !state.job) refresh();
  } catch {
    /* the regular rebuild catches up */
  } finally {
    changeCheck.running = false;
  }
}

const status = () => ({
  version: state.version,
  busy: Boolean(state.job),
  busyWithNotion: Boolean(state.job?.notion),
  progress: state.progress,
  generatedAt: state.model?.generatedAt ?? null,
  notionFetchedAt: state.snapshot?.fetchedAt ?? null,
  notionError: state.notionError,
  gitlabError: state.gitlabError,
  notionMaxAgeMinutes: config.notion.maxAgeMinutes,
  gitlabMaxAgeSeconds: config.gitlab.maxAgeSeconds,
});

// ---------------------------------------------------------------------------------------------

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(response, code, body) {
  response.writeHead(code, { 'content-type': CONTENT_TYPES['.json'], 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function serveStatic(response, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.join(publicDir, relative);
  if (!file.startsWith(publicDir + path.sep)) return sendJson(response, 404, { error: 'not found' });
  try {
    const body = await fs.readFile(file);
    response.writeHead(200, {
      'content-type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    response.end(body);
  } catch {
    sendJson(response, 404, { error: 'not found' });
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
  try {
    if (url.pathname === '/api/status') {
      // The page asks every few seconds while it is in view, which is exactly when changes matter.
      checkForChanges();
      return sendJson(response, 200, status());
    }

    if (url.pathname === '/api/data' && request.method === 'GET') {
      if (!state.model) {
        // First paint: use the stored tickets if there are any, and refresh them right after.
        await refresh();
        if (notionStale() && state.snapshot) refresh({ notion: true });
      } else if (notionStale() || gitlabStale()) {
        refresh({ notion: notionStale() });
      }
      return sendJson(response, 200, { status: status(), model: state.model });
    }

    if (url.pathname === '/api/refresh' && request.method === 'POST') {
      await refresh({ notion: url.searchParams.get('notion') === '1' });
      // A request queued behind a running job starts when that job ends; wait for it as well.
      while (state.job) await state.job.promise;
      return sendJson(response, 200, { status: status(), model: state.model });
    }

    if (request.method === 'GET') return serveStatic(response, url.pathname);
    sendJson(response, 405, { error: 'method not allowed' });
  } catch (error) {
    sendJson(response, 500, { error: error.message });
  }
});

server.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${port} jest zajęty. Ustaw inny: PORT=4456 npm start` : error.message);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  const address = `http://localhost:${port}`;
  console.log(`Mapa ticketów: ${address}`);
  if (!process.argv.includes('--no-open')) execFile('open', [address], () => {});
});
