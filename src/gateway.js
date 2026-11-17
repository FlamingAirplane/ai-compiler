// The core that every interface (HTTP API, MCP server, CLI) calls into.
// chat() takes an OpenAI-style request body and always returns a web
// Response, so callers only ever deal with one shape.

import { join } from 'node:path';
import { APP, VERSION, loadConfig, loadEnvFile, readJson, resolvePaths, saveEnvVars } from './config.js';
import { Providers, normalizeCatalog, baseName } from './providers.js';
import { Quota, nextDayReset } from './quota.js';
import { Router, errorMessage } from './router.js';
import { loadSkills } from './skills.js';
import { createTools, TOOL_ENV } from './tools.js';
import { HarnessError, MODES, MODE_INFO, runHarness, withSystem } from './harness.js';
import { contentText, estimateTokens, parseSseLine, sseData, sseDone, sseNote } from './sse.js';

class RequestError extends Error {
  constructor(failure) {
    super(failure.message);
    this.failure = failure;
  }
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('cancelled'));
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('cancelled'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Read a provider's stream up to its first real event. A stream that opens
 * with an error, or ends without saying anything, can still be retried on
 * another model because nothing has reached the caller yet.
 */
async function peekStream(reader, timeoutMs) {
  const dec = new TextDecoder();
  const chunks = [];
  let buf = '';
  let size = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    reader.cancel().catch(() => {});
  }, timeoutMs);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { verdict: 'empty', chunks, message: timedOut ? `no answer within ${Math.round(timeoutMs / 1000)}s` : 'the stream ended without an answer' };
      chunks.push(value);
      size += value.length;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line === 'data: [DONE]') return { verdict: 'empty', chunks, message: 'the stream ended without an answer' };
        const ev = parseSseLine(line);
        if (!ev) continue;
        if (ev.error) return { verdict: 'error', chunks, message: errorMessage(JSON.stringify({ error: ev.error })) || 'the stream reported an error' };
        const choice = ev.choices?.[0];
        const d = choice?.delta;
        if (d && ((typeof d.content === 'string' && d.content) || d.tool_calls?.length || d.reasoning_content || d.reasoning)) return { verdict: 'ok', chunks };
        // Finishing before saying anything (a reasoning model that ran out of tokens) is not an answer.
        if (choice?.finish_reason) return choice.finish_reason === 'tool_calls' ? { verdict: 'ok', chunks } : { verdict: 'empty', chunks, message: 'the reply was empty' };
      }
      if (size > 256 * 1024) return { verdict: 'ok', chunks };
    }
  } finally {
    clearTimeout(timer);
  }
}

const newId = () => `chatcmpl-aic-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const headerSafe = (v) => String(v ?? '').replace(/[^\x20-\x7e]/g, '?');
const STREAM_HEADERS = { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' };

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

const metaHeaders = (m) => ({ 'x-aic-mode': m.mode, 'x-aic-provider': headerSafe(m.provider), 'x-aic-model': headerSafe(m.model) });

/** Put one chunk in front of a byte stream. */
function prepend(first, stream) {
  const reader = stream.getReader();
  let sent = false;
  return new ReadableStream({
    async pull(ctrl) {
      if (!sent) {
        sent = true;
        ctrl.enqueue(first);
        return;
      }
      const { done, value } = await reader.read();
      if (done) ctrl.close();
      else ctrl.enqueue(value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

/** Send already-written text as an OpenAI-style stream. */
function emitText(push, text, model) {
  const id = newId();
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta, finish = null) => sseData({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] });
  push(chunk({ role: 'assistant', content: '' }));
  for (let i = 0; i < text.length; i += 400) push(chunk({ content: text.slice(i, i + 400) }));
  push(chunk({}, 'stop'));
  push(sseDone());
}

function emitError(push, f) {
  push(sseData({ error: { message: f?.message ?? 'Something went wrong', type: 'aic_error', code: f?.code ?? 'error' } }));
  push(sseDone());
}

export function createCore(opts = {}) {
  return new Core(opts);
}

export class Core {
  /**
   * opts: paths (config, catalog, envFile, dataDir, skillsDir), or in-memory
   * overrides for tests: catalogData, configData, fetch, now, memory: true.
   */
  constructor(opts = {}) {
    this.paths = resolvePaths(opts);
    this.config = loadConfig(this.paths.config, opts.configData);
    const raw = opts.catalogData ?? readJson(this.paths.catalog, null);
    if (!raw) throw new Error(`Cannot read the provider catalog at ${this.paths.catalog}`);
    this.now = opts.now ?? Date.now;
    const fetchImpl = opts.fetch ?? fetch;
    const data = (name) => (opts.memory ? null : join(this.paths.dataDir, name));

    // Keys come from .env, and from the real environment when set there.
    this.env = opts.memory ? { ...(opts.env ?? {}) } : { ...loadEnvFile(this.paths.envFile), ...(opts.env ?? {}) };
    this.providers = new Providers({ catalog: normalizeCatalog(raw), env: this.env, cacheFile: data('models.json'), fetchImpl, now: this.now });
    this.keyNames = [...new Set([...this.providers.envNames(), ...TOOL_ENV])];
    if (!opts.memory) for (const n of this.keyNames) if (process.env[n]) this.env[n] = process.env[n];

    this.quota = new Quota({ file: data('usage.json'), now: this.now, tzOf: (id) => this.providers.get(id)?.resetTz ?? 'UTC' });
    this.router = new Router({
      providers: this.providers,
      quota: this.quota,
      fetchImpl,
      now: this.now,
      strategy: this.config.strategy,
      maxAttempts: this.config.maxAttempts,
      timeoutMs: this.config.timeoutMs,
    });
    this.skills = loadSkills(this.paths.skillsDir);
    this.tools = createTools({
      config: this.config,
      env: this.env,
      fetchImpl,
      now: this.now,
      count: (name) => this.quota.countRequest(`tool:${name}`, 'call'),
      ...(opts.toolOptions ?? {}),
    });
    this.memory = !!opts.memory;
    this.activity = [];
  }

  /** Make sure we know each configured provider's models. Cheap once cached. */
  ready() {
    return this.providers.discoverAll();
  }

  close() {
    this.quota.flush();
  }

  // ------------------------------------------------------------- requests

  /**
   * The model name carries the routing: "auto", "auto:fast", "groq",
   * "groq/<model>", a harness ("boost", "ensemble", "refine", "agent",
   * "panel"), a skill ("skill:code-review"), or a harness with a skill
   * ("boost@code-review"). Unknown names mean "auto", so tools that insist on
   * sending "gpt-4o" still work.
   */
  parseModel(model, extra = {}) {
    let s = String(model ?? '').trim();
    let skill = extra.skill ?? null;
    let mode = extra.mode ?? null;
    const at = s.lastIndexOf('@');
    if (at !== -1) {
      const after = s.slice(at + 1).toLowerCase();
      if (after === 'auto' || this.skills.has(after)) {
        skill ??= after;
        s = s.slice(0, at);
      }
    }
    const named = s.match(/^skill[:/](.+)$/i);
    if (named) {
      skill ??= named[1];
      s = '';
    }
    if (s.toLowerCase() === 'boost' || Object.hasOwn(MODES, s.toLowerCase())) {
      mode ??= s;
      s = '';
    }
    return { mode: mode ? String(mode).toLowerCase() : null, skill: skill ? String(skill).toLowerCase() : null, spec: s || 'auto' };
  }

  async prepare(body, signal) {
    const parsed = this.parseModel(body.model, body.aic && typeof body.aic === 'object' ? body.aic : {});
    let skill = null;
    if (parsed.skill === 'auto') {
      skill = await this.pickSkill(body.messages, signal);
    } else if (parsed.skill) {
      skill = this.skills.get(parsed.skill);
      if (!skill) throw new RequestError({ status: 400, code: 'unknown_skill', message: `There is no skill called "${parsed.skill}". GET /api/skills lists them.` });
    }
    let mode = parsed.mode === 'boost' ? skill?.boost ?? this.config.harness.boost : parsed.mode ?? skill?.mode ?? 'single';
    if (!Object.hasOwn(MODES, mode)) mode = 'single';
    // A caller that sends its own tools is running its own agent loop and
    // expects tool calls back, which a multi-stage text pipeline would swallow.
    const clientTools = (Array.isArray(body.tools) && body.tools.length > 0) || body.messages.some((m) => m.role === 'tool' || m.tool_calls?.length);
    if (clientTools) mode = 'single';

    let spec = parsed.spec;
    if (skill?.tier && spec === 'auto') spec = `auto:${skill.tier}`;
    const params = { ...body };
    for (const k of ['messages', 'model', 'stream', 'aic']) delete params[k];
    if (mode !== 'single') for (const k of ['tools', 'tool_choice', 'parallel_tool_calls', 'n', 'stream_options']) delete params[k];
    if (skill?.temperature != null && params.temperature == null) params.temperature = skill.temperature;
    return {
      mode,
      skill,
      spec,
      routeSpec: this.router.parseSpec(spec),
      messages: skill ? withSystem(body.messages, skill.prompt) : body.messages,
      params,
      stream: !!body.stream,
      needTools: clientTools,
    };
  }

  /** "skill:auto": let a fast model choose the skill. */
  async pickSkill(messages, signal) {
    const last = [...messages].reverse().find((m) => m.role === 'user');
    const menu = [...this.skills.values()].map((s) => `${s.name}: ${s.description}`).join('\n');
    const r = await this.complete(
      {
        messages: [
          { role: 'system', content: `You route requests to skills. Reply with only the name of the single best skill for the user's request, or "none" if no skill fits.\n\nSkills:\n${menu}` },
          { role: 'user', content: contentText(last?.content).slice(0, 4000) },
        ],
        temperature: 0,
        max_tokens: 64,
      },
      { spec: 'auto:fast', signal },
    );
    if (!r.ok) return null;
    const reply = r.text.toLowerCase();
    return [...this.skills.values()].sort((a, b) => b.name.length - a.name.length).find((s) => reply.includes(s.name)) ?? null;
  }

  async chat(body, { signal } = {}) {
    const base = { source: String(body?.aic?.source ?? 'api').slice(0, 20), started: this.now(), mode: 'single', skill: null };
    if (!body || typeof body !== 'object' || !Array.isArray(body.messages) || !body.messages.length) {
      return this.failed(base, { status: 400, code: 'invalid_request', message: 'The request needs a non-empty "messages" array.' });
    }
    let req = base;
    try {
      await this.ready();
      req = { ...base, ...(await this.prepare(body, signal)) };
      return req.mode === 'single' ? await this.single(req, signal) : await this.harnessed(req, signal);
    } catch (err) {
      if (signal?.aborted) return this.failed(req, { status: 499, code: 'cancelled', message: 'The request was cancelled.' });
      if (err instanceof RequestError || err instanceof HarnessError) return this.failed(req, err.failure);
      throw err;
    }
  }

  /** Remember a finished request for the dashboard's recent-activity list. */
  record(req, fields) {
    this.activity.unshift({
      at: this.now(),
      source: req?.source ?? 'api',
      mode: req?.mode ?? 'single',
      skill: req?.skill?.name ?? null,
      ms: req?.started != null ? this.now() - req.started : null,
      ...fields,
    });
    if (this.activity.length > 40) this.activity.length = 40;
  }

  failed(req, f) {
    this.record(req, { ok: false, code: f.code ?? 'error', error: f.message, fallbacks: Math.max(0, (f.attempts?.length ?? 0) - 1) });
    return this.errorResponse(f);
  }

  /** Route a request. If every free tier is resting but one is back within a few seconds, wait for it. */
  async route(body, opts = {}) {
    const deadline = this.now() + (opts.wait === false ? 0 : this.config.waitForQuotaMs ?? 0);
    for (let i = 0; ; i++) {
      const r = await this.router.chat(body, opts);
      if (r.ok || r.code !== 'all_limited' || !r.retryAt || r.retryAt > deadline || i >= 3) return r;
      await sleep(Math.max(0, r.retryAt - this.now()) + 200, opts.signal);
    }
  }

  errorResponse(f) {
    const headers = {};
    if (f.retryAt) headers['retry-after'] = String(Math.max(1, Math.ceil((f.retryAt - this.now()) / 1000)));
    return json(
      f.status >= 400 && f.status <= 599 ? f.status : 502,
      {
        error: {
          message: f.message,
          type: 'aic_error',
          code: f.code ?? 'error',
          attempts: f.attempts ?? [],
          skipped: f.skipped ?? [],
          retry_at: f.retryAt ? new Date(f.retryAt).toISOString() : null,
        },
      },
      headers,
    );
  }

  // -------------------------------------------------- one call, accounted

  /** A non-streaming model call. Returns the parsed reply, or the router's failure. */
  async complete(body, opts = {}) {
    for (let tries = 0; ; tries++) {
      const r = await this.route({ ...body, stream: false }, opts);
      if (!r.ok) return r;
      let data = null;
      try {
        data = await r.upstream.json();
      } catch {
        /* handled below */
      } finally {
        r.release?.();
      }
      const message = data?.choices?.[0]?.message;
      const empty = message && !contentText(message.content).trim() && !message.tool_calls?.length;
      if (!message || empty) {
        // Some providers answer 200 with an error inside, or with nothing at
        // all (a reasoning model that ran out of tokens). Rest that model and
        // go round again.
        const why = empty ? 'the reply was empty' : data == null ? 'the reply was not JSON' : errorMessage(JSON.stringify(data)) || 'the reply had no message';
        this.router.backoff(r.provider, r.model.id, 60e3, 'sent an unusable reply');
        this.quota.failure(r.provider.id, r.model.id, { status: 200, message: why });
        if (tries < 2) continue;
        return { ok: false, status: 502, code: 'bad_upstream_response', message: `${r.provider.name} sent an unusable reply: ${why}`, attempts: r.attempts, skipped: [], retryAt: null };
      }
      const text = contentText(message.content);
      this.quota.addTokens(r.provider.id, r.model.id, data.usage?.total_tokens ?? estimateTokens(body.messages) + Math.ceil(text.length / 4));
      return {
        ok: true,
        json: data,
        message,
        text,
        toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
        usage: data.usage ?? null,
        provider: r.provider,
        model: r.model,
        attempts: r.attempts,
      };
    }
  }

  /**
   * A streaming model call. The returned byte stream is the provider's, with
   * token counting attached. A stream that opens with an error is retried on
   * another model before anything is passed on.
   */
  async open(body, opts = {}) {
    for (let tries = 0; ; tries++) {
      const r = await this.route({ ...body, stream: true }, opts);
      if (!r.ok) return r;
      const contentType = r.upstream.headers.get('content-type') ?? 'text/event-stream';
      const reader = r.upstream.body.getReader();
      let head = [];
      if (contentType.includes('event-stream')) {
        let peek;
        try {
          peek = await peekStream(reader, this.config.timeoutMs * 2);
        } catch (err) {
          r.release?.();
          throw err;
        }
        head = peek.chunks;
        if (peek.verdict !== 'ok') {
          reader.cancel().catch(() => {});
          r.release?.();
          this.router.backoff(r.provider, r.model.id, 60e3, 'sent an unusable reply');
          this.quota.failure(r.provider.id, r.model.id, { status: 200, message: peek.message });
          if (tries < 2) continue;
          return { ok: false, status: 502, code: 'bad_upstream_response', message: `${r.provider.name} sent an unusable reply: ${peek.message}`, attempts: r.attempts, skipped: [], retryAt: null };
        }
      }
      const estimateIn = estimateTokens(body.messages);
      const dec = new TextDecoder();
      let usage = null;
      let outChars = 0;
      let buf = '';
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        r.release?.();
        this.quota.addTokens(r.provider.id, r.model.id, usage?.total_tokens ?? estimateIn + Math.ceil(outChars / 4));
      };
      const observe = (chunk) => {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) !== -1) {
          const ev = parseSseLine(buf.slice(0, i).trim());
          buf = buf.slice(i + 1);
          if (!ev) continue;
          if (ev.usage) usage = ev.usage;
          const d = ev.choices?.[0]?.delta;
          if (!d) continue;
          if (typeof d.content === 'string') outChars += d.content.length;
          if (typeof d.reasoning_content === 'string') outChars += d.reasoning_content.length;
          for (const t of d.tool_calls ?? []) outChars += t.function?.arguments?.length ?? 0;
        }
      };
      const stream = new ReadableStream({
        async pull(ctrl) {
          try {
            if (head.length) {
              const chunk = head.shift();
              observe(chunk);
              ctrl.enqueue(chunk);
              return;
            }
            const { done, value } = await reader.read();
            if (done) {
              finish();
              ctrl.close();
            } else {
              observe(value);
              ctrl.enqueue(value);
            }
          } catch (err) {
            finish();
            ctrl.error(err);
          }
        },
        cancel(reason) {
          finish();
          return reader.cancel(reason).catch(() => {});
        },
      });
      return { ...r, stream, contentType };
    }
  }

  async single(req, signal) {
    const body = { ...req.params, messages: req.messages };
    const opts = { spec: req.spec, needTools: req.needTools, signal };
    const meta = (r) => ({ mode: 'single', skill: req.skill?.name ?? null, provider: r.provider.id, model: r.model.id, attempts: r.attempts });
    if (req.stream) {
      const r = await this.open(body, opts);
      if (!r.ok) return this.failed(req, r);
      const m = meta(r);
      this.record(req, { ok: true, stream: true, provider: m.provider, model: m.model, fallbacks: m.attempts.length - 1 });
      const isSse = r.contentType.includes('event-stream');
      return new Response(isSse ? prepend(sseNote({ event: 'route', ...m }), r.stream) : r.stream, {
        status: 200,
        headers: { ...STREAM_HEADERS, 'content-type': r.contentType, ...metaHeaders(m) },
      });
    }
    const r = await this.complete(body, opts);
    if (!r.ok) return this.failed(req, r);
    const m = meta(r);
    this.record(req, { ok: true, provider: m.provider, model: m.model, fallbacks: m.attempts.length - 1, tokens: r.usage?.total_tokens ?? null });
    return json(200, { ...r.json, aic: m }, metaHeaders(m));
  }

  // --------------------------------------------------------------- harness

  /** Up to n different models that can take a request now, spread across providers first. */
  pick(spec, n, opts = {}) {
    const { list } = this.router.plan(spec, opts);
    const picks = [];
    const used = new Set();
    for (const c of list) {
      if (picks.length >= n) break;
      if (used.has(c.p.id)) continue;
      used.add(c.p.id);
      picks.push(c);
    }
    for (const c of list) {
      if (picks.length >= n) break;
      if (!picks.includes(c)) picks.push(c);
    }
    return picks.map((c) => ({ provider: c.p.id, model: c.model.id, name: c.p.name }));
  }

  newRun(req, signal) {
    const core = this;
    const run = {
      stages: [],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      note: () => {},
    };
    run.ctx = {
      config: this.config.harness,
      tools: this.tools,
      signal,
      note: (o) => run.note(o),
      pick: (spec, n, o) => this.pick(spec, n, o),
      async call(messages, { params = {}, role = 'step', ...opts } = {}) {
        const t0 = core.now();
        const r = await core.complete({ ...params, messages }, { ...opts, signal });
        const stage = { role, ok: r.ok, provider: r.ok ? r.provider.id : null, model: r.ok ? r.model.id : null, ms: core.now() - t0 };
        if (!r.ok) stage.error = r.message;
        run.stages.push(stage);
        for (const k of Object.keys(run.usage)) run.usage[k] += r.usage?.[k] ?? 0;
        run.note({ event: 'stage', ...stage });
        if (!r.ok) return { ok: false, error: r };
        return { ok: true, text: r.text, message: r.message, toolCalls: r.toolCalls, provider: r.provider.id, model: r.model.id, name: r.provider.name };
      },
    };
    return run;
  }

  async harnessed(req, signal) {
    // Fail with a real HTTP status when nothing at all can serve the request.
    const pre = this.router.plan(req.routeSpec);
    if (!pre.list.length) return this.failed(req, this.router.fail([], pre.skipped));
    return req.stream ? this.harnessStream(req, signal) : this.harnessJson(req, signal);
  }

  summary(req, run) {
    return { mode: req.mode, skill: req.skill?.name ?? null, stages: run.stages, requests: run.stages.length };
  }

  async harnessJson(req, signal) {
    const run = this.newRun(req, signal);
    const out = await runHarness(req.mode, run.ctx, req);
    let text = out.text ?? '';
    if (out.final) {
      const r = await run.ctx.call(out.final.messages, { params: out.final.params, role: out.final.role, ...out.final.opts });
      if (r.ok) text = r.text;
      else if (out.fallbackText != null) text = out.fallbackText;
      else throw new HarnessError(r.error);
    }
    this.record(req, { ok: true, requests: run.stages.length, provider: run.stages.findLast((s) => s.ok)?.provider ?? null, model: run.stages.findLast((s) => s.ok)?.model ?? null });
    return json(
      200,
      {
        id: newId(),
        object: 'chat.completion',
        created: Math.floor(this.now() / 1000),
        model: `aic/${req.mode}`,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: run.usage,
        aic: this.summary(req, run),
      },
      { 'x-aic-mode': req.mode },
    );
  }

  harnessStream(req, signal) {
    const ac = new AbortController();
    const onAbort = () => ac.abort(signal.reason);
    if (signal?.aborted) ac.abort(signal.reason);
    else signal?.addEventListener('abort', onAbort, { once: true });
    const run = this.newRun(req, ac.signal);
    const model = `aic/${req.mode}`;

    const work = async (push) => {
      const out = await runHarness(req.mode, run.ctx, req);
      if (!out.final) {
        emitText(push, out.text ?? '', model);
        return;
      }
      const t0 = this.now();
      const r = await this.open({ ...out.final.params, messages: out.final.messages }, { ...out.final.opts, signal: ac.signal });
      const stage = { role: out.final.role, ok: r.ok, provider: r.ok ? r.provider.id : null, model: r.ok ? r.model.id : null, ms: this.now() - t0 };
      run.stages.push(stage);
      run.note({ event: 'stage', ...stage });
      if (!r.ok) {
        if (out.fallbackText != null) emitText(push, out.fallbackText, model);
        else emitError(push, r);
      } else if (r.contentType.includes('event-stream')) {
        for await (const chunk of r.stream) push(chunk);
      } else {
        // The provider ignored stream:true and sent plain JSON.
        const data = await new Response(r.stream).json().catch(() => null);
        emitText(push, contentText(data?.choices?.[0]?.message?.content), model);
      }
    };

    const stream = new ReadableStream({
      start: (ctrl) => {
        let open = true;
        const push = (bytes) => {
          if (!open) return;
          try {
            ctrl.enqueue(bytes);
          } catch {
            open = false;
          }
        };
        run.note = (o) => push(sseNote(o));
        work(push)
          .then(() => {
            run.note({ event: 'done', ...this.summary(req, run) });
            const last = run.stages.findLast((s) => s.ok);
            this.record(req, { ok: true, stream: true, requests: run.stages.length, provider: last?.provider ?? null, model: last?.model ?? null });
          })
          .catch((err) => {
            if (ac.signal.aborted) return this.record(req, { ok: false, code: 'cancelled', error: 'The request was cancelled.' });
            const f = err instanceof HarnessError ? err.failure : { code: 'internal_error', message: String(err?.message ?? err) };
            this.record(req, { ok: false, code: f.code ?? 'error', error: f.message, requests: run.stages.length });
            emitError(push, f);
          })
          .finally(() => {
            signal?.removeEventListener('abort', onAbort);
            open = false;
            try {
              ctrl.close();
            } catch {
              /* already closed by a cancel */
            }
          });
      },
      cancel: () => ac.abort(),
    });
    return new Response(stream, { status: 200, headers: { ...STREAM_HEADERS, 'x-aic-mode': req.mode } });
  }

  // ------------------------------------------------------------ management

  /** Save API keys to .env (an empty value removes one), then re-check the providers they belong to. */
  async setKeys(vars) {
    const clean = {};
    for (const [k, v] of Object.entries(vars ?? {})) {
      if (!this.keyNames.includes(k)) throw new RequestError({ status: 400, code: 'unknown_key', message: `"${k}" is not a key this app uses.` });
      const value = String(v ?? '').trim();
      if (/[\s\0]/.test(value) || value.length > 600) throw new RequestError({ status: 400, code: 'bad_key', message: `The value for ${k} does not look like an API key.` });
      clean[k] = value;
    }
    if (!this.memory) saveEnvVars(this.paths.envFile, clean);
    for (const [k, v] of Object.entries(clean)) {
      if (v) this.env[k] = v;
      else delete this.env[k];
    }
    const touched = this.providers.all.filter((p) => p.required.some((n) => n in clean));
    for (const p of touched) this.quota.clearCooldowns(p.id);
    await Promise.all(touched.map((p) => this.providers.discover(p, { force: true })));
    return this.status();
  }

  async refresh() {
    await this.providers.discoverAll({ force: true });
    return this.status();
  }

  /**
   * Send one tiny request through a provider to prove the key, the model list
   * and the chat endpoint all work. Costs one free request.
   */
  async testProvider(id, { signal } = {}) {
    const p = this.providers.get(id);
    if (!p) throw new RequestError({ status: 404, code: 'unknown_provider', message: `There is no provider called "${id}".` });
    if (!this.providers.configured(p)) return { provider: id, name: p.name, ok: false, message: `No key set (needs ${this.providers.missing(p).join(', ')}).` };
    await this.providers.discover(p);
    const req = { source: 'check', mode: 'check', started: this.now() };
    const r = await this.complete(
      { messages: [{ role: 'user', content: 'Reply with the single word: ready' }], temperature: 0 },
      { spec: { provider: id }, signal, wait: false },
    );
    const ms = this.now() - req.started;
    if (r.ok) {
      this.record(req, { ok: true, provider: id, model: r.model.id, fallbacks: r.attempts.length - 1 });
      return { provider: id, name: p.name, ok: true, model: r.model.id, ms, reply: r.text.replace(/\s+/g, ' ').trim().slice(0, 60), fallbacks: r.attempts.length - 1 };
    }
    this.record(req, { ok: false, provider: id, code: r.code, error: r.message });
    const when = r.retryAt ? ` Back at ${new Date(r.retryAt).toLocaleTimeString()}.` : '';
    const why = String(r.attempts?.at(-1)?.message ?? r.message).replace(/[.\s]*$/, '.');
    return { provider: id, name: p.name, ok: false, ms, code: r.code, message: `${why}${when}` };
  }

  async testAll({ signal } = {}) {
    await this.ready();
    const ids = this.providers.all.filter((p) => this.providers.configured(p) && !(p.local && this.providers.keyStatus(p) !== 'ok')).map((p) => p.id);
    return Promise.all(ids.map((id) => this.testProvider(id, { signal })));
  }

  models() {
    const data = [];
    const add = (id, owned_by, description) => data.push({ id, object: 'model', created: 0, owned_by, description });
    add('auto', APP, 'Best free model available right now, with automatic fallback.');
    add('auto:smart', APP, 'Same, preferring the larger models.');
    add('auto:fast', APP, 'Same, preferring the small quick models.');
    add('boost', APP, `The default harness (${this.config.harness.boost}), or the one a skill prefers.`);
    for (const [mode, info] of Object.entries(MODE_INFO)) add(mode, APP, info);
    for (const s of this.skills.values()) add(`skill:${s.name}`, APP, s.description);
    const shared = new Map();
    for (const p of this.providers.all) {
      for (const m of this.providers.models(p)) {
        const name = baseName(m.id);
        if (!shared.has(name)) shared.set(name, new Set());
        shared.get(name).add(p.name);
      }
    }
    for (const [name, names] of shared) if (names.size > 1) add(name, APP, `Served by ${[...names].join(', ')}. Tried on each of them first.`);
    for (const p of this.providers.all) for (const m of this.providers.models(p)) add(`${p.id}/${m.id}`, p.id, `${p.name} (${m.tier})`);
    return { object: 'list', data };
  }

  skillList() {
    return [...this.skills.values()].map(({ prompt, ...s }) => s);
  }

  status() {
    const now = this.now();
    const providers = this.providers.all.map((p) => {
      const configured = this.providers.configured(p);
      const keyStatus = this.providers.keyStatus(p);
      const q = this.quota.view(p.id);
      const models = this.providers.models(p).map((m) => {
        const c = this.quota.cooling(p.id, m.id);
        return { id: m.id, tier: m.tier, tools: m.tools, today: q.models[m.id] ?? null, coolingUntil: c?.until ?? null, coolingReason: c?.reason ?? null };
      });
      let state = 'ready';
      if (!configured) state = 'no_key';
      else if (keyStatus === 'rejected') state = 'rejected';
      else if (keyStatus === 'unchecked') state = 'checking';
      else if (!models.length) state = keyStatus === 'ok' ? 'no_models' : p.local ? 'offline' : 'unreachable';
      else if (models.every((m) => m.coolingUntil)) state = 'cooling';
      return {
        id: p.id,
        name: p.name,
        local: !!p.local,
        signupUrl: p.signupUrl ?? null,
        freeTier: p.freeTier ?? '',
        hint: p.hint ?? null,
        env: p.required,
        missing: this.providers.missing(p),
        shared: !!p.sharedQuota,
        state,
        availableAt: state === 'cooling' ? Math.min(...models.map((m) => m.coolingUntil)) : null,
        coolingReason: state === 'cooling' ? models[0].coolingReason : null,
        resetAt: nextDayReset(now, p.resetTz),
        models,
        today: { requests: q.requests, tokens: q.tokens, limited: q.limited, errors: q.errors },
        total: q.total,
        history: q.history,
        limits: q.limits,
        lastUsed: q.lastUsed,
        lastError: q.lastError,
        day: q.day,
        problem: configured ? this.providers.entry(p)?.error ?? null : null,
      };
    });
    const search = this.quota.view('tool:tavily');
    return {
      app: APP,
      version: VERSION,
      now,
      strategy: this.config.strategy,
      harness: {
        boost: this.config.harness.boost,
        proposers: this.config.harness.ensemble.proposers,
        modes: MODE_INFO,
        agent: { ...this.config.harness.agent, workspace: this.tools.workspace },
      },
      tools: this.tools.describe(),
      toolKeys: TOOL_ENV.map((name) => ({ name, set: !!this.env[name] })),
      searchesToday: search.requests,
      searchesTotal: search.total.requests,
      skills: this.skills.size,
      activity: this.activity.slice(0, 25),
      providers,
      totals: {
        ready: providers.filter((p) => p.state === 'ready').length,
        configured: providers.filter((p) => p.state !== 'no_key' && p.state !== 'offline').length,
        requests: providers.reduce((n, p) => n + p.today.requests, 0),
        tokens: providers.reduce((n, p) => n + p.today.tokens, 0),
      },
    };
  }
}
