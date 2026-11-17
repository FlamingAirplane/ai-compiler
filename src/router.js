import { parseReset, nextDayReset } from './quota.js';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// How many of each provider's best models are tried before going deeper into
// any one provider. Breadth first gives better answers than draining one
// provider's weakest models before touching the next provider's best.
const FIRST_PASS = 2;

export function errorMessage(text) {
  if (!text) return '';
  try {
    let j = JSON.parse(text);
    if (Array.isArray(j)) j = j[0];
    const e = j?.error;
    const msg = (typeof e === 'string' ? e : e?.message) ?? j?.message ?? j?.detail;
    if (msg) return (typeof msg === 'string' ? msg : JSON.stringify(msg)).slice(0, 400);
  } catch {
    /* not JSON */
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, 400);
}

const TOO_LARGE = /context[ _-]?(length|window)|maximum context|too (long|large)|reduce the length|exceeds? the (maximum|limit|context)|prompt is too long|input.{0,30}too long/i;

/** What kind of failure an upstream HTTP status means for routing. */
export function classify(status, text, needTools = false) {
  if (status === 413) return 'too_large';
  if (status === 429) return /request too large|too large for model/i.test(text) ? 'too_large' : 'limited';
  if (status === 401) return 'auth';
  if (status === 402) return 'credits';
  if (status === 403) return /quota|limit|credit|billing|exceed/i.test(text) ? 'credits' : 'forbidden';
  if (status === 404) return 'no_model';
  if (status === 400 || status === 422) {
    if (/api[ _-]?key|unauthorized|authenticat/i.test(text)) return 'auth';
    if (needTools && /tool|function/i.test(text)) return 'no_tools';
    if (TOO_LARGE.test(text)) return 'too_large';
    if (/model.{0,40}(not found|does not exist|not supported|decommissioned|deprecated|no longer)|unknown model|invalid model/i.test(text)) return 'no_model';
    return 'bad_request';
  }
  return 'server';
}

// Failures that say something about this model and this request, not about
// the provider: move on to the next model without counting it against anyone.
const MODEL_ONLY = new Set(['too_large', 'no_tools', 'no_model', 'forbidden']);

const abortError = (signal) => signal?.reason ?? Object.assign(new Error('Request was cancelled'), { name: 'AbortError' });

/**
 * Sends one chat request to the first provider that can take it. A provider
 * that is out of quota, down, or rejects the request is put on a cooldown and
 * the next one is tried, so free quota anywhere gets used before giving up.
 */
export class Router {
  constructor({ providers, quota, fetchImpl = fetch, now = Date.now, strategy = 'priority', maxAttempts = 8, timeoutMs = 45000 }) {
    Object.assign(this, { providers, quota, now, strategy, maxAttempts, timeoutMs });
    this.fetch = fetchImpl;
    this.rr = 0;
    this.noTools = new Set();
  }

  /**
   * "auto", "auto:smart", "auto:fast", "<provider>", "<provider>/<model>", or
   * a model name several providers serve ("gpt-oss-120b"), which is tried on
   * each of them first. Anything else means auto, so tools that insist on
   * sending "gpt-4o" still work.
   */
  parseSpec(model) {
    if (model && typeof model === 'object') return model;
    const s = String(model ?? '').trim();
    const lower = s.toLowerCase();
    if (!s || lower === 'auto') return {};
    if (lower === 'auto:smart' || lower === 'smart') return { tier: 'smart' };
    if (lower === 'auto:fast' || lower === 'fast') return { tier: 'fast' };
    const slash = s.indexOf('/');
    const p = this.providers.get(slash === -1 ? s : s.slice(0, slash));
    if (p) return slash === -1 ? { provider: p.id } : { provider: p.id, model: s.slice(slash + 1) };
    if (this.providers.servedBy(s).length) return { modelName: s };
    return {};
  }

  /**
   * Everything that could serve a request right now, in the order to try it.
   * `first` pins one candidate to the front; `avoid` pushes providers (then
   * exact models) that are already in use to the back, which is how the
   * ensemble gets answers from different models.
   */
  candidates(specIn, { needTools = false, first = null, avoid = [] } = {}) {
    const spec = this.parseSpec(specIn);
    const list = [];
    const skipped = [];
    let provs = this.providers.all.filter((p) => this.providers.configured(p));
    if (spec.provider) provs = provs.filter((p) => p.id === spec.provider);
    else if (this.strategy === 'round-robin' && provs.length > 1) {
      const k = this.rr++ % provs.length;
      provs = [...provs.slice(k), ...provs.slice(0, k)];
    }
    for (const p of provs) {
      const ks = this.providers.keyStatus(p);
      if (ks === 'rejected') {
        skipped.push({ provider: p.id, reason: 'API key was rejected' });
        continue;
      }
      let models = this.providers.models(p);
      if (!models.length && !spec.model) {
        skipped.push({ provider: p.id, reason: ks === 'unreachable' ? 'not reachable' : 'no models found' });
        continue;
      }
      if (spec.model) models = [models.find((m) => m.id === spec.model) ?? { id: spec.model, tier: 'smart', tools: null }];
      else if (spec.tier) models = models.filter((m) => m.tier === spec.tier);
      let rank = 0;
      for (const m of models) {
        if (needTools && (m.tools === false || this.noTools.has(`${p.id}/${m.id}`))) {
          skipped.push({ provider: p.id, model: m.id, reason: 'no tool calling' });
          continue;
        }
        const c = this.quota.cooling(p.id, m.id);
        if (c) skipped.push({ provider: p.id, model: m.id, reason: c.reason, until: c.until });
        else list.push({ p, model: m, rank: rank++ });
      }
    }

    const wanted = spec.modelName ? new Set(this.providers.servedBy(spec.modelName).map((x) => `${x.p.id}/${x.model.id}`)) : null;
    const avoidModels = new Set(avoid.map((a) => `${a.provider}/${a.model}`));
    const avoidProviders = new Set(avoid.map((a) => a.provider));
    const order = (c) => {
      if (first && c.p.id === first.provider && c.model.id === first.model) return 0;
      if (wanted && !wanted.has(`${c.p.id}/${c.model.id}`)) return 4; // a named model is a preference, not a limit
      if (!avoidProviders.has(c.p.id)) return 1;
      return avoidModels.has(`${c.p.id}/${c.model.id}`) ? 3 : 2;
    };
    const pass = (c) => (spec.provider || c.rank < FIRST_PASS ? 0 : 1);
    const ordered = list
      .map((c, i) => ({ c, i, o: order(c), pass: pass(c) }))
      .sort((a, b) => a.o - b.o || a.pass - b.pass || a.i - b.i)
      .map((x) => x.c);
    return { list: ordered, skipped };
  }

  /** Like candidates(), but a tier with nothing available falls back to any tier. */
  plan(specIn, opts = {}) {
    const spec = this.parseSpec(specIn);
    const out = this.candidates(spec, opts);
    if (!out.list.length && spec.tier) return this.candidates({ ...spec, tier: undefined }, opts);
    return out;
  }

  async chat(body, opts = {}) {
    const spec = this.parseSpec(opts.spec ?? body.model);
    const needTools = !!opts.needTools;
    const { list, skipped } = this.plan(spec, opts);
    const attempts = [];
    const dead = new Set();
    const strikes = new Map();
    let bad = 0;
    for (const c of list) {
      if (attempts.length >= this.maxAttempts || bad >= 3) break;
      if (dead.has(c.p.id) || opts.exclude?.has(`${c.p.id}/${c.model.id}`)) continue;
      const r = await this.tryOne(c, body, opts.signal, needTools);
      attempts.push(r.attempt);
      if (r.ok) return { ok: true, upstream: r.upstream, release: r.release, provider: c.p, model: c.model, attempts };
      const { kind } = r.attempt;
      if (kind === 'auth' || kind === 'credits') dead.add(c.p.id);
      else if (kind === 'bad_request') bad++;
      else if (!MODEL_ONLY.has(kind)) {
        // Rate limits, server errors and timeouts: two strikes and the
        // provider sits out the rest of this request, so attempts spread out.
        const n = (strikes.get(c.p.id) ?? 0) + 1;
        strikes.set(c.p.id, n);
        if (n >= 2 || (kind === 'limited' && c.p.sharedQuota)) dead.add(c.p.id);
      }
    }
    return this.fail(attempts, skipped, bad >= 3);
  }

  async tryOne({ p, model }, body, signal, needTools, stripped = false) {
    const started = this.now();
    const payload = { ...body, model: model.id };
    delete payload.aic;
    for (const k of p.dropParams ?? []) delete payload[k];
    const attempt = { provider: p.id, model: model.id };
    if (signal?.aborted) throw abortError(signal);
    const ctl = new AbortController();
    const onAbort = () => ctl.abort(abortError(signal));
    signal?.addEventListener('abort', onAbort, { once: true });
    const release = () => signal?.removeEventListener('abort', onAbort);
    // The clock only runs until response headers arrive. A non-streaming reply
    // sends no headers until the whole answer is written, so it gets longer.
    const limit = payload.stream ? this.timeoutMs : this.timeoutMs * 3;
    const timer = setTimeout(() => ctl.abort(new Error(`no response within ${Math.round(limit / 1000)}s`)), limit);
    let res;
    try {
      res = await this.fetch(`${this.providers.baseUrl(p)}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: payload.stream ? 'text/event-stream' : 'application/json',
          ...this.providers.authHeaders(p),
        },
        body: JSON.stringify(payload),
        signal: ctl.signal,
      });
    } catch (err) {
      release();
      if (signal?.aborted) throw abortError(signal);
      const message = ctl.signal.aborted ? String(ctl.signal.reason?.message ?? 'timed out') : err?.cause?.code ?? err?.message ?? String(err);
      Object.assign(attempt, { status: 0, kind: 'network', message, ms: this.now() - started });
      this.backoff(p, model.id, 30 * SEC, 'connection failed');
      this.quota.failure(p.id, model.id, { status: 0, message });
      return { ok: false, attempt };
    } finally {
      clearTimeout(timer);
    }
    attempt.status = res.status;
    attempt.ms = this.now() - started;
    const shared = !!p.sharedQuota;
    if (res.ok) {
      this.quota.countRequest(p.id, model.id);
      this.quota.observe(p.id, model.id, res.headers, { shared });
      attempt.kind = 'ok';
      return { ok: true, upstream: res, attempt, release };
    }
    this.quota.observe(p.id, model.id, res.headers, { shared });
    const text = await res.text().catch(() => '');
    release();
    const message = errorMessage(text) || res.statusText || `HTTP ${res.status}`;

    // A token-related rejection of a request that set an output cap usually
    // means the cap is above what this model allows (or, on Groq, that the cap
    // counts against a per-minute token budget). Let the provider pick the cap.
    const capped = payload.max_tokens != null || payload.max_completion_tokens != null;
    if (!stripped && capped && [400, 413, 422].includes(res.status) && /token/i.test(text)) {
      const { max_tokens, max_completion_tokens, ...rest } = body;
      return this.tryOne({ p, model }, rest, signal, needTools, true);
    }

    const kind = classify(res.status, text, needTools);
    Object.assign(attempt, { kind, message });
    const now = this.now();
    switch (kind) {
      case 'limited': {
        const scope = shared ? '*' : model.id;
        const { until, reason, strike } = this.limitUntil(p, scope, res, text);
        this.quota.cool(p.id, scope, until, reason, { strike });
        break;
      }
      case 'auth':
        this.providers.markRejected(p, message);
        break;
      case 'credits':
        this.quota.cool(p.id, '*', nextDayReset(now, p.resetTz), 'free credit used up');
        break;
      case 'forbidden':
        this.quota.cool(p.id, model.id, now + 6 * HOUR, 'model not available to this account');
        break;
      case 'no_model':
        this.quota.cool(p.id, model.id, now + 6 * HOUR, 'model no longer offered');
        this.providers.discover(p, { force: true }).catch(() => {});
        break;
      case 'no_tools':
        this.noTools.add(`${p.id}/${model.id}`);
        break;
      case 'server':
        this.backoff(p, model.id, 30 * SEC, `provider error ${res.status}`);
        break;
      default:
        break;
    }
    this.quota.failure(p.id, model.id, { status: res.status, message, limited: kind === 'limited' || kind === 'credits' });
    return { ok: false, attempt };
  }

  backoff(p, scope, baseMs, reason) {
    const strikes = this.quota.strikes(p.id, scope);
    this.quota.cool(p.id, scope, this.now() + Math.min(baseMs * 2 ** strikes, 10 * MIN), reason);
  }

  /** When a rate-limited provider should be tried again, from whatever it told us. */
  limitUntil(p, scope, res, text) {
    const now = this.now();
    const tomorrow = nextDayReset(now, p.resetTz);
    // Gemini answers "limit: 0" for models the free tier does not include.
    // Asking again before tomorrow is pointless.
    if (/free[_ ]tier/i.test(text) && /\blimit:\s*0\b/.test(text)) {
      return { until: Math.max(tomorrow, now + 6 * HOUR), reason: 'not included in your free tier', strike: false };
    }
    const daily = /per[ -]?day|daily|\brpd\b|\btpd\b/i.test(text);
    // Providers whose daily quota resets at a fixed time (Gemini at midnight
    // Pacific) send a short retry delay that is wrong for a daily limit.
    if (daily && p.dailyReset === 'fixed') return { until: tomorrow, reason: 'daily limit reached', strike: false };

    const strikes = this.quota.strikes(p.id, scope);
    let until = null;
    const header = res.headers.get('retry-after');
    if (header) until = parseReset(header, now);
    if (!until) {
      const m =
        text.match(/retry_?(?:delay|after)"?\s*[:=]\s*"?(\d+(?:\.\d+)?(?:ms|[smhd])?)/i) ??
        text.match(/try again in\s+((?:\d+(?:\.\d+)?(?:ms|[dhms]))+)/i);
      if (m) until = parseReset(m[1], now);
    }
    if (!until && daily) until = tomorrow;
    if (!until) until = now + MIN;
    // A provider that keeps refusing gets left alone for longer each time.
    if (strikes >= 1) until = Math.max(until, now + Math.min(MIN * 2 ** strikes, HOUR));
    return { until: Math.min(Math.max(until, now + SEC), now + 2 * DAY), reason: daily ? 'daily limit reached' : 'rate limited', strike: true };
  }

  fail(attempts, skipped, rejectedByAll = false) {
    const configured = this.providers.all.filter((p) => this.providers.configured(p));
    const waits = skipped.map((s) => s.until).filter(Boolean);
    for (const a of attempts) {
      const c = this.quota.cooling(a.provider, a.model);
      if (c) waits.push(c.until);
    }
    const retryAt = waits.length ? Math.min(...waits) : null;
    const base = { ok: false, attempts, skipped, retryAt };
    // A local runner that is not running does not count as being set up.
    const usable = configured.filter((p) => !(p.local && this.providers.keyStatus(p) !== 'ok'));
    if (!usable.length) {
      return { ...base, status: 503, code: 'no_providers', message: 'No AI providers are set up yet. Add at least one free API key (open the dashboard, or put it in .env).' };
    }
    const last = attempts.at(-1);
    if (!attempts.length) {
      if (skipped.some((s) => s.until)) {
        return { ...base, status: 429, code: 'all_limited', message: 'Every free tier you have set up is rate limited right now.' };
      }
      const why = skipped.length ? ` (${[...new Set(skipped.map((s) => `${s.provider}: ${s.reason}`))].join('; ')})` : '';
      return { ...base, status: 503, code: 'no_models', message: `No model is available for this request${why}.` };
    }
    if (rejectedByAll) {
      return { ...base, status: last.status || 400, code: 'upstream_rejected', message: `Providers rejected the request: ${last.message}` };
    }
    if (attempts.every((a) => a.kind === 'too_large')) {
      return { ...base, status: 413, code: 'too_large', message: 'The request is too large for every model that was tried. Shorten the conversation, or ask for a smaller max_tokens.' };
    }
    if (attempts.every((a) => a.kind === 'limited' || a.kind === 'credits')) {
      return { ...base, status: 429, code: 'all_limited', message: 'Every free tier that was tried is out of quota right now.' };
    }
    return { ...base, status: 502, code: 'all_failed', message: `All providers failed. Last error from ${last.provider}: ${last.message}` };
  }
}
