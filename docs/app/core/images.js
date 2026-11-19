// Image generation on free tiers, with the same idea as chat: try the first
// provider that has quota, rest the ones that refuse, fall through to the next.
//
// Image APIs are not standardised the way chat is, so each provider has a
// `kind` that says how to ask and how to read the answer.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nextDayReset, parseReset } from './quota.js';
import { readJson, writeAtomic } from './config.js';
import { errorMessage } from './router.js';

const MIN = 60e3;
const HOUR = 60 * MIN;

/** "1024x768" → { width, height }, clamped to 256–1536 and rounded to a multiple of 64. */
export function parseSize(size) {
  const m = String(size ?? '').match(/^(\d{2,4})\s*[x×]\s*(\d{2,4})$/i);
  const fit = (n) => Math.min(1536, Math.max(256, Math.round(Number(n) / 64) * 64));
  return m ? { width: fit(m[1]), height: fit(m[2]) } : { width: 1024, height: 1024 };
}

/** The image type from its first bytes, or null if it is not an image. */
export function sniff(buf) {
  if (buf.length < 32) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/** How to ask each kind of provider for an image. */
const KINDS = {
  // Cloudflare Workers AI. FLUX answers with JSON holding base64; Stable Diffusion answers with raw bytes.
  cloudflare: (q, model) => ({
    method: 'POST',
    body: model.includes('flux') ? { prompt: q.prompt, steps: 8, ...(q.seed != null && { seed: q.seed }) } : { prompt: q.prompt, width: q.width, height: q.height, ...(q.seed != null && { seed: q.seed }) },
  }),
  // NVIDIA's hosted image models answer with { artifacts: [{ base64 }] }.
  nvidia: (q, model) => ({
    method: 'POST',
    headers: { accept: 'application/json' },
    body: { prompt: q.prompt, width: q.width, height: q.height, seed: q.seed ?? 0, ...(model.includes('schnell') && { steps: 4 }) },
  }),
  // Hugging Face Inference answers with raw image bytes.
  huggingface: (q) => ({
    method: 'POST',
    headers: { accept: 'image/png' },
    body: { inputs: q.prompt, parameters: { width: q.width, height: q.height, ...(q.seed != null && { seed: q.seed }) } },
  }),
  // Pollinations needs no key. private=true keeps the prompt off its public feed.
  pollinations: (q, model) => ({
    method: 'GET',
    query: { width: q.width, height: q.height, seed: q.seed ?? Math.floor(Math.random() * 1e9), nologo: 'true', private: 'true', safe: 'true', ...(model !== 'default' && { model }) },
  }),
};

/** Find the image in a JSON answer, whichever shape the provider uses. */
function imageFromJson(j) {
  const b64 = j?.result?.image ?? j?.image ?? j?.artifacts?.[0]?.base64 ?? j?.data?.[0]?.b64_json ?? j?.images?.[0] ?? null;
  if (typeof b64 !== 'string') return null;
  return Buffer.from(b64.replace(/^data:[^,]*,/, ''), 'base64');
}

const filtered = (j) => /filter|safety|nsfw/i.test(String(j?.artifacts?.[0]?.finishReason ?? ''));

export function normalizeImageCatalog(list = []) {
  return list
    .filter((p) => p.enabled !== false && KINDS[p.kind])
    .map((p) => ({ ...p, name: p.name ?? p.id, required: [p.keyEnv, ...(p.extraEnv ?? [])].filter(Boolean), models: p.models?.length ? p.models : ['default'] }));
}

/** Saved images: files in a folder plus a small index, newest first. */
export class ImageStore {
  constructor(dir, { max = 300 } = {}) {
    this.dir = dir;
    this.max = max;
    this.indexFile = join(dir, 'index.json');
  }

  list() {
    return readJson(this.indexFile, []);
  }

  save(buf, mime, meta) {
    mkdirSync(this.dir, { recursive: true });
    const slug = meta.prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'image';
    const file = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}-${slug}.${EXT[mime] ?? 'png'}`;
    writeFileSync(join(this.dir, file), buf);
    const entry = { file, ...meta, mime, bytes: buf.length };
    const list = [entry, ...this.list()];
    for (const old of list.splice(this.max)) this.unlink(old.file);
    writeAtomic(this.indexFile, JSON.stringify(list, null, 1));
    return entry;
  }

  read(file) {
    const entry = this.list().find((e) => e.file === file);
    if (!entry || !/^[\w.-]+$/.test(file)) return null;
    const path = join(this.dir, file);
    return existsSync(path) ? { entry, data: readFileSync(path) } : null;
  }

  remove(file) {
    const list = this.list();
    const kept = list.filter((e) => e.file !== file);
    if (kept.length === list.length) return false;
    this.unlink(file);
    writeAtomic(this.indexFile, JSON.stringify(kept, null, 1));
    return true;
  }

  unlink(file) {
    if (!/^[\w.-]+$/.test(file)) return;
    try {
      unlinkSync(join(this.dir, file));
    } catch {
      /* already gone */
    }
  }
}

export class ImageRouter {
  constructor({ catalog, env, quota, fetchImpl = fetch, now = Date.now, timeoutMs = 120000, maxAttempts = 6 }) {
    Object.assign(this, { all: normalizeImageCatalog(catalog), env, quota, now, timeoutMs, maxAttempts });
    this.fetch = fetchImpl;
  }

  pid = (p) => `image:${p.id}`;
  configured = (p) => p.required.every((n) => this.env[n]);
  get = (id) => this.all.find((p) => p.id === id);

  url(p, model, q, query) {
    const fill = (tpl) =>
      tpl
        .replace(/\{model\}/g, model.split('/').map(encodeURIComponent).join('/').replace(/%40/g, '@'))
        .replace(/\{prompt\}/g, encodeURIComponent(q.prompt))
        .replace(/\{([A-Z0-9_]+)\}/g, (_, n) => encodeURIComponent(this.env[n] ?? ''));
    const u = new URL(fill(p.url));
    for (const [k, v] of Object.entries(query ?? {})) u.searchParams.set(k, String(v));
    return u;
  }

  /** "auto", "<provider>" or "<provider>/<model>". */
  candidates(spec = 'auto') {
    const s = String(spec || 'auto');
    const slash = s.indexOf('/');
    let want = s === 'auto' ? null : { provider: slash === -1 ? s : s.slice(0, slash), model: slash === -1 ? null : s.slice(slash + 1) };
    // OpenAI clients send names like "dall-e-3": anything that is not one of ours means auto.
    if (want && !this.get(want.provider)) want = null;
    const list = [];
    const skipped = [];
    for (const p of this.all) {
      if (want && p.id !== want.provider) continue;
      if (!this.configured(p)) {
        skipped.push({ provider: p.id, reason: 'no key' });
        continue;
      }
      for (const model of want?.model ? [want.model] : p.models) {
        const c = this.quota.cooling(this.pid(p), model);
        if (c) skipped.push({ provider: p.id, model, reason: c.reason, until: c.until });
        else list.push({ p, model });
      }
    }
    return { list, skipped };
  }

  /** Generate one image. Returns { ok, data, mime, provider, model, ms, attempts } or a failure. */
  async generate(q, { spec, signal } = {}) {
    const { list, skipped } = this.candidates(spec);
    const attempts = [];
    const dead = new Set();
    let refused = 0;
    for (const { p, model } of list) {
      if (attempts.length >= this.maxAttempts || refused >= 2) break;
      if (dead.has(p.id)) continue;
      const r = await this.tryOne(p, model, q, signal);
      attempts.push(r.attempt);
      if (r.ok) return { ok: true, data: r.data, mime: r.mime, provider: p, model, ms: r.attempt.ms, attempts };
      if (r.attempt.kind === 'auth' || r.attempt.kind === 'limited') dead.add(p.id);
      if (r.attempt.kind === 'refused') refused++;
    }
    const waits = [...skipped.map((s) => s.until), ...attempts.map((a) => this.quota.cooling(`image:${a.provider}`, a.model)?.until)].filter(Boolean);
    const retryAt = waits.length ? Math.min(...waits) : null;
    const base = { ok: false, attempts, skipped, retryAt };
    if (!this.all.some((p) => this.configured(p))) return { ...base, status: 503, code: 'no_providers', message: 'No image provider is set up. Add a Cloudflare, NVIDIA or Hugging Face key.' };
    if (!attempts.length) return { ...base, status: skipped.some((s) => s.until) ? 429 : 503, code: skipped.some((s) => s.until) ? 'all_limited' : 'no_models', message: skipped.some((s) => s.until) ? 'Every free image tier you have is resting right now.' : 'No image model is available.' };
    const last = attempts.at(-1);
    if (refused >= 2 || attempts.every((a) => a.kind === 'refused')) return { ...base, status: 400, code: 'refused', message: `The prompt was refused: ${last.message}` };
    if (attempts.every((a) => a.kind === 'limited')) return { ...base, status: 429, code: 'all_limited', message: 'Every free image tier that was tried is out of quota right now.' };
    return { ...base, status: 502, code: 'all_failed', message: `Image generation failed. Last error from ${last.provider}: ${last.message}` };
  }

  async tryOne(p, model, q, signal) {
    const started = this.now();
    const attempt = { provider: p.id, model };
    const pid = this.pid(p);
    const req = KINDS[p.kind](q, model);
    const key = p.keyEnv && this.env[p.keyEnv];
    const ctl = new AbortController();
    const onAbort = () => ctl.abort(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctl.abort(new Error(`no image within ${this.timeoutMs / 1000}s`)), this.timeoutMs);
    let res;
    let buf;
    try {
      res = await this.fetch(this.url(p, model, q, req.query), {
        method: req.method,
        headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(req.body ? { 'content-type': 'application/json' } : {}), ...(req.headers ?? {}) },
        body: req.body ? JSON.stringify(req.body) : undefined,
        signal: ctl.signal,
      });
      buf = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err;
      const message = ctl.signal.aborted ? String(ctl.signal.reason?.message ?? 'timed out') : err?.cause?.code ?? err?.message ?? String(err);
      Object.assign(attempt, { status: 0, kind: 'network', message, ms: this.now() - started });
      this.backoff(pid, model, 'connection failed');
      this.quota.failure(pid, model, { status: 0, message });
      return { ok: false, attempt };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    attempt.status = res.status;
    attempt.ms = this.now() - started;
    const text = sniff(buf) ? '' : buf.toString('utf8', 0, 4000);

    if (res.ok) {
      let data = sniff(buf) ? buf : null;
      let json = null;
      if (!data) {
        try {
          json = JSON.parse(text);
        } catch {
          /* handled below */
        }
        data = imageFromJson(json);
      }
      const mime = data && sniff(data);
      if (mime) {
        this.quota.countRequest(pid, model);
        attempt.kind = 'ok';
        return { ok: true, data, mime, attempt };
      }
      const kind = filtered(json) ? 'refused' : 'server';
      Object.assign(attempt, { kind, message: kind === 'refused' ? "blocked by the provider's safety filter" : 'the reply held no image' });
      if (kind === 'server') this.backoff(pid, model, 'sent no image');
      this.quota.failure(pid, model, { status: res.status, message: attempt.message });
      return { ok: false, attempt };
    }

    const message = errorMessage(text) || `HTTP ${res.status}`;
    const now = this.now();
    let kind;
    // Shared free services also say "busy" with a 503 and "retry after 10s".
    const busy = /at (its|the) limit|limit reached|too many|retry after|try again in/i.test(text);
    if (res.status === 429 || busy || (res.status === 403 && /quota|limit|exceed|neuron/i.test(text))) {
      kind = 'limited';
      const daily = /per[ -]?day|daily|neuron|quota/i.test(text);
      const header = res.headers.get('retry-after');
      const said = text.match(/(?:retry|try again)\s+(?:after|in)\s+(\d+(?:\.\d+)?)\s*(s|sec|seconds?|m|min|minutes?)\b/i);
      const fromText = said ? now + Number(said[1]) * (/^m/i.test(said[2]) ? MIN : 1000) : null;
      const until = (header && parseReset(header, now)) || fromText || (daily ? nextDayReset(now, p.resetTz ?? 'UTC') : now + MIN);
      this.quota.cool(pid, '*', until, daily ? 'daily limit reached' : 'rate limited');
    } else if (res.status === 401 || res.status === 403) {
      kind = 'auth';
      this.quota.cool(pid, '*', now + 12 * HOUR, 'key rejected or not allowed to make images');
    } else if (res.status === 404 || /model.{0,40}(not found|does not exist|not supported|no longer)/i.test(text)) {
      kind = 'no_model';
      this.quota.cool(pid, model, now + 6 * HOUR, 'model not available');
    } else if (res.status === 400 || res.status === 422) {
      kind = 'refused';
    } else {
      kind = 'server';
      this.backoff(pid, model, `provider error ${res.status}`);
    }
    Object.assign(attempt, { kind, message });
    this.quota.failure(pid, model, { status: res.status, message, limited: kind === 'limited' });
    return { ok: false, attempt };
  }

  backoff(pid, scope, reason) {
    const strikes = this.quota.strikes(pid, scope);
    this.quota.cool(pid, scope, this.now() + Math.min(30e3 * 2 ** strikes, 10 * MIN), reason);
  }

  status() {
    return this.all.map((p) => {
      const q = this.quota.view(this.pid(p));
      const cool = this.quota.cooling(this.pid(p), null);
      const models = p.models.map((m) => ({ id: m, coolingUntil: this.quota.cooling(this.pid(p), m)?.until ?? null }));
      let state = !this.configured(p) ? 'no_key' : cool ? 'cooling' : models.every((m) => m.coolingUntil) ? 'cooling' : 'ready';
      return {
        id: p.id,
        name: p.name,
        state,
        keyless: !p.required.length,
        env: p.required,
        signupUrl: p.signupUrl ?? null,
        freeTier: p.freeTier ?? '',
        models,
        availableAt: state === 'cooling' ? cool?.until ?? Math.min(...models.map((m) => m.coolingUntil)) : null,
        coolingReason: cool?.reason ?? null,
        today: { requests: q.requests, errors: q.errors + q.limited },
        lastError: q.lastError,
      };
    });
  }
}
