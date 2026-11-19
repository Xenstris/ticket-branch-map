/**
 * Read-only GitLab REST access through the `glab` CLI, so the token never leaves glab's keyring.
 * Every call is a GET; nothing here can change a repository.
 */

import { execFile } from 'node:child_process';
import os from 'node:os';

import { createLimiter } from './util.mjs';

export class GitLabError extends Error {
  constructor(message, { status = null, endpoint } = {}) {
    super(message);
    this.name = 'GitLabError';
    this.status = status;
    this.endpoint = endpoint;
  }
}

export class GitLab {
  constructor({ hostname = 'gitlab.com', concurrency = 12, bin = 'glab' } = {}) {
    this.hostname = hostname;
    this.bin = bin;
    this.limit = createLimiter(concurrency);
    this.calls = 0;
  }

  /** `encodeURIComponent`, named for what it is used for: project paths, branch names, file paths. */
  static id(value) {
    return encodeURIComponent(String(value));
  }

  /** GET one endpoint and parse the JSON body. */
  get(endpoint, query = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      for (const item of Array.isArray(value) ? value : [value]) params.append(key, String(item));
    }
    const suffix = params.size ? `?${params}` : '';
    const url = `${endpoint}${suffix}`;

    return this.limit(
      () =>
        new Promise((resolve, reject) => {
          this.calls += 1;
          execFile(
            this.bin,
            ['api', '--hostname', this.hostname, url],
            // Outside a git directory glab leaves `:id`-style placeholders in the endpoint alone.
            { cwd: os.tmpdir(), maxBuffer: 128 * 1024 * 1024, timeout: 60_000 },
            (error, stdout, stderr) => {
              if (error) {
                if (error.code === 'ENOENT') {
                  reject(new GitLabError('Nie znaleziono polecenia `glab` (GitLab CLI).', { endpoint }));
                  return;
                }
                const status = /\(HTTP (\d{3})\)/.exec(stderr)?.[1];
                const detail = stderr.trim().split('\n').at(-1) || error.message;
                reject(new GitLabError(detail, { status: status ? Number(status) : null, endpoint }));
                return;
              }
              try {
                resolve(JSON.parse(stdout));
              } catch {
                reject(new GitLabError(`Odpowiedź GitLaba nie jest JSON-em (${endpoint})`, { endpoint }));
              }
            },
          );
        }),
    );
  }

  /** GET every page of a list endpoint, up to `maxPages` pages of 100. */
  async list(endpoint, query = {}, { maxPages = 10 } = {}) {
    const items = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const batch = await this.get(endpoint, { ...query, per_page: 100, page });
      items.push(...batch);
      if (batch.length < 100) break;
    }
    return items;
  }

  /** Like `get`, but a 404 is an answer (`null`), not a failure. */
  async find(endpoint, query = {}) {
    try {
      return await this.get(endpoint, query);
    } catch (error) {
      if (error instanceof GitLabError && error.status === 404) return null;
      throw error;
    }
  }
}
