import { createHash } from 'node:crypto';
import { readJson, writeAtomic } from './config.js';

const TTL_OK = 12 * 3600e3;
const TTL_FAIL = 5 * 60e3;
const TTL_LOCAL = 60e3;

// Model ids that are not chat models (embeddings, speech, image generation, safety classifiers...).
const NON_CHAT = /embed|rerank|guard|safety|moderation|whisper|tts|speech|transcri|audio|image|imagen|video|veo|clip|ocr|detector|translate|calibration|retriev|robotics|computer-use|starcoder|diffusion|flux|sdxl|lyria|bge-|(^|[-_/])live([-_/]|$)/i;
// Words that mark a small or speed-oriented model ("gpt-4o-mini" yes, "minimax" no).
const FAST_WORDS = /\b(flash|lite|mini|nano|small|instant|lightning|bolt|haiku|tiny|xs)\b/i;
const UNSTABLE = /preview|experimental|-exp\b|beta/i;

const re = (s) => (s ? new RegExp(s, 'i') : null);

export function normalizeCatalog(raw) {
  const list = Array.isArray(raw) ? raw : raw?.providers;
  if (!Array.isArray(list)) throw new Error('The provider catalog must contain a "providers" array');
  const seen = new Set();
  return list
    .filter((p) => p.enabled !== false)
    .map((p) => {
      if (!p.id || !p.baseUrl) throw new Error('Each provider needs an "id" and a "baseUrl"');
      if (seen.has(p.id)) throw new Error(`Duplicate provider id "${p.id}"`);
      seen.add(p.id);
      let resetTz = p.resetTz ?? 'UTC';
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: resetTz });
      } catch {
        resetTz = 'UTC';
      }
      return {
        ...p,
        name: p.name ?? p.id,
        resetTz,
        required: [p.keyEnv, ...(p.extraEnv ?? [])].filter(Boolean),
        _include: re(p.include),
        _exclude: re(p.exclude),
        _fast: re(p.fast),
        _prefer: (p.prefer ?? []).map(re),
      };
    });
}

/**
 * Total parameter count in billions named in a model id: "llama-3.3-70b" is
 * 70, "mistral-large-1t" is 1000, "mixtral-8x7b" is 56. Active-parameter
 * counts in mixture-of-experts names ("-a12b") are ignored, because they
 * describe speed, not size.
 */
export function sizeOf(id) {
  let max = 0;
  for (const m of String(id).toLowerCase().matchAll(/(?<![a-z0-9.])(\d+(?:\.\d+)?)(?:x(\d+(?:\.\d+)?))?([bt])(?![a-z0-9])/g)) {
    const n = Number(m[1]) * (m[2] ? Number(m[2]) : 1) * (m[3] === 't' ? 1000 : 1);
    if (n > max) max = n;
  }
  return max;
}

/** "fast" for small or speed-tuned models, "smart" for the rest. A catalog `fast` pattern overrides the guess. */
export function tierOf(p, id) {
  if (p._fast) return p._fast.test(id) ? 'fast' : 'smart';
  if (FAST_WORDS.test(id)) return 'fast';
  const size = sizeOf(id);
  return size > 0 && size < 30 ? 'fast' : 'smart';
}

/** The Artificial Analysis intelligence index, when the provider publishes it (OpenRouter does). */
const published = (item) => {
  const index = item?.benchmarks?.artificial_analysis?.intelligence_index;
  return typeof index === 'number' ? index : null;
};

/**
 * Give every model a rough quality score, used only to order one provider's
 * models. Published scores win. When some models in a list have one, the
 * others get the middle of those scores, since a size guess is on a different
 * scale. When none do, the score is guessed from the parameter count.
 */
function score(items) {
  const known = items.map((m) => m.published).filter((n) => n != null).sort((a, b) => a - b);
  const mid = known.length ? (known[Math.floor((known.length - 1) / 2)] + known[Math.ceil((known.length - 1) / 2)]) / 2 : null;
  for (const m of items) m.score = m.published ?? mid ?? (m.size ? 12 + 6 * Math.log2(m.size + 1) : 35);
}

/** Dated or numbered snapshots of one model share a family: "mistral-large-2411" and "mistral-large-latest". */
export const family = (id) => id.toLowerCase().replace(/[-_@](?:\d{3,8}|\d{4}-\d{2}(?:-\d{2})?|\d{2}-\d{4}|latest)$/, '');

/** The part of a model id that is the same on every provider: "openai/gpt-oss-120b:free" is "gpt-oss-120b". */
export const baseName = (id) => String(id).toLowerCase().replace(/:free$/, '').split('/').pop();

function toolSupport(item) {
  if (Array.isArray(item.supported_parameters)) return item.supported_parameters.includes('tools');
  if (Array.isArray(item.capabilities)) return item.capabilities.some((c) => /tool/i.test(String(c)));
  if (Array.isArray(item.providers) && item.providers.length && 'supports_tools' in item.providers[0]) {
    return item.providers.some((x) => x.supports_tools);
  }
  return null;
}

/**
 * Turn a provider's raw model listing into the short ranked list the router
 * uses. Nothing here is hardcoded to model names that will be stale next
 * month: the catalog's `prefer` patterns order what the provider says it has.
 */
export function rankModels(p, json) {
  const list = Array.isArray(json) ? json : json?.data ?? json?.models ?? json?.result ?? [];
  const field = p.modelIdField ?? 'id';
  const seen = new Set();
  const items = [];
  for (const item of Array.isArray(list) ? list : []) {
    const id = String((typeof item === 'string' ? item : item?.[field] ?? item?.id ?? item?.name) ?? '').replace(/^models\//, '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (p.freeSuffix && !id.endsWith(p.freeSuffix)) continue;
    if (p._include && !p._include.test(id)) continue;
    if (p._exclude && p._exclude.test(id)) continue;
    if (NON_CHAT.test(id)) continue;
    const out = item?.supported_output_modalities ?? item?.architecture?.output_modalities;
    if (Array.isArray(out) && !out.includes('text')) continue;
    items.push({
      id,
      tier: tierOf(p, id),
      tools: typeof item === 'object' ? toolSupport(item) : null,
      context: item?.context_length ?? item?.context_window ?? item?.inputTokenLimit ?? null,
      created: Number(item?.created) || 0,
      size: sizeOf(id),
      published: published(item),
    });
  }
  score(items);
  const pref = (id) => {
    const i = p._prefer.findIndex((r) => r.test(id));
    return i === -1 ? p._prefer.length : i;
  };
  items.sort(
    (a, b) =>
      pref(a.id) - pref(b.id) ||
      UNSTABLE.test(a.id) - UNSTABLE.test(b.id) ||
      b.score - a.score ||
      (b.size || 20) - (a.size || 20) ||
      b.created - a.created ||
      b.id.localeCompare(a.id, 'en', { numeric: true }),
  );
  // One model per family (the best-ranked snapshot), then a few of each tier
  // so both "smart" and "fast" requests have somewhere to go.
  const families = new Set();
  const cap = Math.ceil((p.maxModels ?? 6) / 2);
  const kept = { smart: 0, fast: 0 };
  return items
    .filter((m) => !families.has(family(m.id)) && families.add(family(m.id)))
    .filter((m) => kept[m.tier]++ < cap)
    .map(({ created, size, published, score, ...m }) => ({ ...m, score: Math.round(score) }));
}

const pinned = (p) =>
  p.models.map((m) => (typeof m === 'string' ? { id: m, tier: tierOf(p, m), tools: null, context: null } : { tier: tierOf(p, m.id), tools: null, context: null, ...m }));

/** The provider catalog plus what we have learned about each provider's models and key. */
export class Providers {
  constructor({ catalog, env, cacheFile = null, fetchImpl = fetch, now = Date.now }) {
    this.all = catalog;
    this.env = env;
    this.cacheFile = cacheFile;
    this.fetch = fetchImpl;
    this.now = now;
    this.cache = (cacheFile && readJson(cacheFile, null)) || {};
    this.inflight = new Map();
  }

  get(id) {
    return this.all.find((p) => p.id === id);
  }

  /** Every provider model whose name matches, ignoring org prefixes and ":free". */
  servedBy(name) {
    const want = baseName(name);
    const out = [];
    for (const p of this.all) for (const m of this.models(p)) if (baseName(m.id) === want) out.push({ p, model: m });
    return out;
  }

  envNames() {
    return [...new Set(this.all.flatMap((p) => p.required))];
  }

  missing(p) {
    return p.required.filter((n) => !this.env[n]);
  }

  configured(p) {
    return this.missing(p).length === 0;
  }

  expand(tpl) {
    return tpl.replace(/\{([A-Z0-9_]+)\}/g, (_, n) => encodeURIComponent(this.env[n] ?? ''));
  }

  baseUrl(p) {
    return this.expand(p.baseUrl).replace(/\/+$/, '');
  }

  modelsUrl(p) {
    return p.modelsUrl ? this.expand(p.modelsUrl) : `${this.baseUrl(p)}/models`;
  }

  authHeaders(p) {
    const key = p.keyEnv && this.env[p.keyEnv];
    return { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(p.headers ?? {}) };
  }

  /** Changes whenever the key or URL changes, so stale cache entries are ignored. */
  fingerprint(p) {
    const material = `${p.required.map((n) => this.env[n] ?? '').join('\n')}|${this.baseUrl(p)}`;
    return createHash('sha256').update(material).digest('hex').slice(0, 12);
  }

  entry(p) {
    const c = this.cache[p.id];
    return c && c.fp === this.fingerprint(p) ? c : null;
  }

  models(p) {
    if (!this.configured(p)) return [];
    if (p.models?.length) return pinned(p);
    return this.entry(p)?.models ?? [];
  }

  /** missing | unchecked | ok | rejected | unreachable | error */
  keyStatus(p) {
    if (!this.configured(p)) return 'missing';
    return this.entry(p)?.status ?? 'unchecked';
  }

  markRejected(p, message) {
    this.cache[p.id] = { ...(this.entry(p) ?? { models: [] }), fp: this.fingerprint(p), at: this.now(), status: 'rejected', error: message ?? null };
    this.persist();
  }

  fresh(p) {
    const c = this.entry(p);
    if (!c) return false;
    if (c.status === 'rejected') return true; // stays rejected until the key changes or a refresh is forced
    const ttl = c.status === 'ok' ? TTL_OK : p.local ? TTL_LOCAL : TTL_FAIL;
    return this.now() - c.at < ttl;
  }

  persist() {
    if (!this.cacheFile) return;
    try {
      writeAtomic(this.cacheFile, JSON.stringify(this.cache, null, 1));
    } catch {
      /* the cache is an optimisation only */
    }
  }

  async discover(p, { force = false } = {}) {
    if (!this.configured(p)) return null;
    if (!force && this.fresh(p)) return this.entry(p);
    if (this.inflight.has(p.id)) return this.inflight.get(p.id);
    const job = this.#discover(p).finally(() => this.inflight.delete(p.id));
    this.inflight.set(p.id, job);
    return job;
  }

  async #discover(p) {
    const fp = this.fingerprint(p);
    const prev = this.entry(p);
    const entry = { fp, at: this.now(), status: 'ok', models: [], error: null };
    const headers = { accept: 'application/json', ...this.authHeaders(p), ...(p.modelsHeaders ?? {}) };
    const timeout = () => AbortSignal.timeout(p.local ? 1500 : 15000);
    const rejected = (status, text) => status === 401 || status === 403 || (status === 400 && /api[ _-]?key/i.test(text));
    try {
      if (p.keyCheckUrl) {
        const res = await this.fetch(this.expand(p.keyCheckUrl), { headers, signal: timeout() });
        const text = await res.text().catch(() => '');
        if (rejected(res.status, text)) entry.status = 'rejected';
      }
      if (entry.status === 'ok' && !p.models?.length) {
        const res = await this.fetch(this.modelsUrl(p), { headers, signal: timeout() });
        const text = await res.text().catch(() => '');
        if (rejected(res.status, text)) {
          entry.status = 'rejected';
        } else if (!res.ok) {
          entry.status = 'error';
          entry.error = `Model list request failed (HTTP ${res.status})`;
        } else {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* handled below */
          }
          if (json == null) {
            entry.status = 'error';
            entry.error = 'Model list was not JSON';
          } else {
            entry.models = rankModels(p, json);
          }
        }
      }
    } catch (err) {
      entry.status = 'unreachable';
      entry.error = err?.cause?.code ?? err?.message ?? String(err);
    }
    if (entry.status === 'rejected') entry.error = 'The provider rejected this API key';
    // A failed refresh should not throw away a model list that was working.
    if ((entry.status === 'error' || entry.status === 'unreachable') && prev?.models?.length && !p.local) entry.models = prev.models;
    if (p.models?.length) entry.models = pinned(p);
    this.cache[p.id] = entry;
    this.persist();
    return entry;
  }

  async discoverAll({ force = false } = {}) {
    await Promise.all(this.all.filter((p) => this.configured(p)).map((p) => this.discover(p, { force })));
  }
}
