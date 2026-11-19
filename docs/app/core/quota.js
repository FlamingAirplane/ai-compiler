import { closeSync, mkdirSync, openSync, statSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { readJson, writeAtomic } from './config.js';

const HISTORY_DAYS = 35;
const DAY = 86400e3;
const LOCK_STALE_MS = 10_000;
const HEADER_RE = /^(?:x-)?ratelimit-(limit|remaining|reset)(?:-(requests|tokens))?(?:-(day|hour|minute|second))?$/i;

/**
 * Turn a rate-limit reset value into an absolute timestamp (ms).
 * Providers disagree on the format: seconds from now ("30"), a duration
 * ("2m59.5s"), epoch seconds, epoch milliseconds, or an HTTP date.
 */
export function parseReset(value, now) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n > 1e12) return n;
    if (n > 1e9) return n * 1000;
    return now + n * 1000;
  }
  const m = s.match(/^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/);
  if (m) {
    const [, d, h, min, sec, ms] = m;
    return now + ((+d || 0) * 86400 + (+h || 0) * 3600 + (+min || 0) * 60 + (+sec || 0)) * 1000 + (+ms || 0);
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

export function dayKey(now, tz = 'UTC') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}

/** Timestamp of the next midnight in the given timezone. */
export function nextDayReset(now, tz = 'UTC') {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(now));
  const get = (t) => Number(parts.find((p) => p.type === t).value) % 24;
  const elapsed = (get('hour') * 3600 + get('minute') * 60 + get('second')) * 1000 + (now % 1000);
  return now + DAY - elapsed;
}

const blank = () => ({
  day: null, requests: 0, tokens: 0, limited: 0, errors: 0, models: {},
  total: { requests: 0, tokens: 0 }, history: {},
  lastUsed: null, lastError: null, cooldowns: {}, limits: {},
});

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // Browsers do not allow blocking waits on the page's main thread.
    const end = Date.now() + ms;
    while (Date.now() < end);
  }
}

function addHistory(s, day, requests, tokens) {
  const h = (s.history[day] ??= { requests: 0, tokens: 0 });
  h.requests += requests;
  h.tokens += tokens;
}

/**
 * Per-provider usage counters, cooldowns and the limits providers report in
 * their response headers, saved to a JSON file so they survive restarts.
 *
 * Several processes can share the file (the server, the command line, the MCP
 * server). Every change is applied in memory at once and also kept as a
 * pending operation. Saving takes a lock, re-reads the file, replays the
 * pending operations on top of whatever other processes wrote, and writes the
 * result, so no process overwrites another's counts or cooldowns.
 */
export class Quota {
  constructor({ file = null, now = Date.now, tzOf = () => 'UTC' } = {}) {
    this.file = file;
    this.now = now;
    this.tzOf = tzOf;
    this.pending = [];
    this.timer = null;
    this.mtime = 0;
    this.checked = 0;
    this.state = this.read();
  }

  read() {
    let state = null;
    if (this.file) {
      try {
        this.mtime = statSync(this.file).mtimeMs;
      } catch {
        this.mtime = 0;
      }
      state = readJson(this.file, null);
    }
    state ??= { providers: {} };
    state.providers ??= {};
    return state;
  }

  /** Pick up what other processes saved. Checks the file at most once a second unless forced. */
  sync(force = false) {
    if (!this.file) return;
    const t = Date.now();
    if (!force && t - this.checked < 1000) return;
    this.checked = t;
    let mtime;
    try {
      mtime = statSync(this.file).mtimeMs;
    } catch {
      return;
    }
    if (mtime === this.mtime) return;
    const fresh = this.read();
    for (const op of this.pending) this.apply(fresh, op);
    this.state = fresh;
  }

  /** The provider's record in `state`, moved on to the day `at` falls in. */
  roll(state, pid, at) {
    const s = (state.providers[pid] ??= blank());
    for (const [k, v] of Object.entries(blank())) s[k] ??= v;
    const day = dayKey(at, this.tzOf(pid));
    if (!s.day || day > s.day) {
      if (s.day && (s.requests || s.tokens)) addHistory(s, s.day, s.requests, s.tokens);
      const keep = Object.keys(s.history).sort().slice(-HISTORY_DAYS);
      s.history = Object.fromEntries(keep.map((k) => [k, s.history[k]]));
      for (const [scope, c] of Object.entries(s.cooldowns)) if (at - c.until > DAY) delete s.cooldowns[scope];
      Object.assign(s, { day, requests: 0, tokens: 0, limited: 0, errors: 0, models: {} });
    }
    return s;
  }

  apply(state, op) {
    const s = this.roll(state, op.pid, op.at);
    const day = dayKey(op.at, this.tzOf(op.pid));
    const today = day === s.day; // false for an operation from before a midnight another process already rolled past
    const model = (id) => (s.models[id] ??= { requests: 0, tokens: 0 });
    switch (op.t) {
      case 'req':
        s.total.requests++;
        s.lastUsed = Math.max(s.lastUsed ?? 0, op.at);
        if (today) {
          s.requests++;
          model(op.model).requests++;
        } else addHistory(s, day, 1, 0);
        // A success resets the strike count of cooldowns that have run out.
        for (const scope of [op.model, '*']) if (s.cooldowns[scope] && s.cooldowns[scope].until <= op.at) delete s.cooldowns[scope];
        break;
      case 'tok':
        s.total.tokens += op.n;
        if (today) {
          s.tokens += op.n;
          model(op.model).tokens += op.n;
        } else addHistory(s, day, 0, op.n);
        break;
      case 'fail':
        if (today) op.limited ? s.limited++ : s.errors++;
        if (!s.lastError || s.lastError.at <= op.at) s.lastError = { at: op.at, status: op.status, model: op.model, message: op.message };
        break;
      case 'cool': {
        const prev = s.cooldowns[op.scope];
        const active = prev && prev.until > op.at;
        s.cooldowns[op.scope] = {
          at: op.at,
          until: Math.max(op.until, active ? prev.until : 0),
          reason: active && prev.until > op.until ? prev.reason : op.reason,
          strikes: (prev?.strikes ?? 0) + (op.strike ? 1 : 0),
        };
        break;
      }
      case 'limits':
        if (!s.limits[op.scope] || s.limits[op.scope].at <= op.at) s.limits[op.scope] = { at: op.at, buckets: op.buckets };
        break;
      case 'clear':
        for (const [scope, c] of Object.entries(s.cooldowns)) if ((c.at ?? 0) <= op.at) delete s.cooldowns[scope];
        break;
      default:
        break;
    }
  }

  op(o) {
    o.at = this.now();
    this.apply(this.state, o);
    if (this.file) {
      this.pending.push(o);
      this.save();
    }
  }

  entry(pid) {
    this.sync();
    return this.roll(this.state, pid, this.now());
  }

  countRequest(pid, model) {
    this.op({ t: 'req', pid, model });
  }

  addTokens(pid, model, n) {
    if (n > 0) this.op({ t: 'tok', pid, model, n });
  }

  failure(pid, model, { status, message, limited = false }) {
    this.op({ t: 'fail', pid, model, status, message: String(message ?? '').slice(0, 300), limited });
  }

  /** How many times in a row this scope has been put on cooldown. */
  strikes(pid, scope) {
    return this.entry(pid).cooldowns[scope]?.strikes ?? 0;
  }

  cool(pid, scope, until, reason, { strike = true } = {}) {
    this.op({ t: 'cool', pid, scope, until, reason, strike });
  }

  /** Active cooldown for a provider/model, or null. '*' covers the whole provider. */
  cooling(pid, model) {
    const s = this.entry(pid);
    const now = this.now();
    let active = null;
    for (const scope of ['*', model]) {
      const c = scope != null && s.cooldowns[scope];
      if (c && c.until > now && (!active || c.until > active.until)) active = { until: c.until, reason: c.reason, scope };
    }
    return active;
  }

  clearCooldowns(pid) {
    this.op({ t: 'clear', pid });
  }

  /** Record rate-limit headers; if a bucket is empty, cool down until it refills. */
  observe(pid, model, headers, { shared = false } = {}) {
    const now = this.now();
    const buckets = {};
    headers.forEach((value, name) => {
      const m = name.match(HEADER_RE);
      if (!m) return;
      const key = `${(m[2] ?? 'requests').toLowerCase()}${m[3] ? '/' + m[3].toLowerCase() : ''}`;
      const b = (buckets[key] ??= {});
      if (m[1].toLowerCase() === 'reset') b.resetAt = parseReset(value, now);
      else if (/^-?\d+(\.\d+)?$/.test(value.trim())) b[m[1].toLowerCase()] = Number(value);
    });
    if (!Object.keys(buckets).length) return;
    const scope = shared ? '*' : model;
    this.op({ t: 'limits', pid, scope, buckets });
    for (const [key, b] of Object.entries(buckets)) {
      if (b.remaining != null && b.remaining <= 0 && b.resetAt && b.resetAt > now) {
        this.cool(pid, scope, Math.min(b.resetAt, now + 2 * DAY), `${key} limit reached`, { strike: false });
      }
    }
  }

  view(pid) {
    const s = this.entry(pid);
    const now = this.now();
    const cooldowns = Object.fromEntries(Object.entries(s.cooldowns).filter(([, c]) => c.until > now));
    return { ...s, cooldowns };
  }

  save() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => this.flush(), 400);
    this.timer.unref?.();
  }

  lock() {
    const path = `${this.file}.lock`;
    const deadline = Date.now() + 2000;
    for (;;) {
      try {
        mkdirSync(dirname(path), { recursive: true });
        closeSync(openSync(path, 'wx'));
        return () => {
          try {
            unlinkSync(path);
          } catch {
            /* already gone */
          }
        };
      } catch (err) {
        if (err.code !== 'EEXIST') return () => {};
        try {
          if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) {
            unlinkSync(path); // left behind by a process that crashed
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() > deadline) return () => {}; // write anyway rather than lose the counts
        sleepSync(15);
      }
    }
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.file || !this.pending.length) return;
    const unlock = this.lock();
    try {
      const fresh = this.read();
      for (const op of this.pending) this.apply(fresh, op);
      writeAtomic(this.file, JSON.stringify(fresh, null, 1));
      this.mtime = statSync(this.file).mtimeMs;
      this.state = fresh;
      this.pending = [];
    } catch {
      /* usage tracking must never break a request */
    } finally {
      unlock();
    }
  }
}
