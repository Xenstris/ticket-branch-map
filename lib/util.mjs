/** Small shared helpers: a concurrency limiter, structural equality, Notion id handling. */

/** Returns `run(fn)` that keeps at most `max` promises in flight. */
export function createLimiter(max) {
  let active = 0;
  const queue = [];

  const next = () => {
    if (active >= max || queue.length === 0) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        next();
      });
  };

  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

/** Structural equality for JSON values; key order does not matter. */
export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    return a.length === b.length && a.every((value, index) => deepEqual(value, b[index]));
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  return keysA.length === keysB.length && keysA.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
}

/** The 32-hex page id a Notion URL ends with; Notion prints the same page as `/p/<id>`, `/<id>` or `/<slug>-<id>`. */
export function notionPageId(url) {
  const match = /([0-9a-f]{32})(?:[?#].*)?$/i.exec(String(url ?? '').replaceAll('-', ''));
  return match ? match[1].toLowerCase() : null;
}

/** `["a","b"]` encoded as a string, the way Notion returns multi-value properties. */
export function parseJsonList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [value];
  }
}

/**
 * A small key-value cache kept in one JSON file. Used for answers that cannot change (how many
 * commits separate two SHAs) or change rarely (what a merge request is called).
 */
export class DiskCache {
  constructor(file, { fs, unusedDays = 21 } = {}) {
    this.file = file;
    this.fs = fs;
    this.unusedMs = unusedDays * 86_400_000;
    this.entries = new Map();
  }

  async load() {
    try {
      const raw = JSON.parse(await this.fs.readFile(this.file, 'utf8'));
      this.entries = new Map(Object.entries(raw));
    } catch {
      this.entries = new Map();
    }
    return this;
  }

  /** The cached value, or `undefined` when missing or older than `maxAgeMs`. */
  get(key, maxAgeMs = Infinity) {
    const entry = this.entries.get(key);
    if (!entry || Date.now() - entry.at > maxAgeMs) return undefined;
    entry.used = Date.now();
    return entry.value;
  }

  set(key, value) {
    const now = Date.now();
    this.entries.set(key, { value, at: now, used: now });
  }

  async save() {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - (entry.used ?? entry.at) > this.unusedMs) this.entries.delete(key);
    }
    const temporary = `${this.file}.${process.pid}.tmp`;
    await this.fs.writeFile(temporary, JSON.stringify(Object.fromEntries(this.entries)));
    await this.fs.rename(temporary, this.file);
  }
}
