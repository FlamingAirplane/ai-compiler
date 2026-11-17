// A stand-in for several AI providers on one local port, used by the tests and
// by `npm run demo`. Each provider lives at /<id>/v1 and speaks the
// OpenAI-compatible API. Behaviour per provider:
//
//   models        list of model ids (or full model objects)
//   key           bearer token it requires; anything else gets 401
//   limit         after this many chat requests, answer 429
//   retryAfter    seconds, sent as Retry-After on a 429
//   limitMessage  body message for the 429
//   rateHeaders   send x-ratelimit-* headers that count down from `limit`
//   status        always fail chat requests with this HTTP status
//   noTools       reject requests that carry tools with a 400
//   maxTokens     reject requests asking for more output tokens than this
//   streamError   answer streaming requests with 200 and an error event
//   delayMs       wait before answering
//   reply         string, or (body, count) => string | { tool_calls } | { raw }

import { createServer } from 'node:http';

const lastUser = (body) => {
  const m = [...(body.messages ?? [])].reverse().find((x) => x.role === 'user');
  const c = m?.content;
  return typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p.text ?? '').join('') : '';
};

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

// A 1x1 PNG, enough to pass as a real image.
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

export async function startMock(behaviors) {
  const hits = {};
  const seen = [];

  // Image endpoints live at /<id>/img/<model or prompt>. image.format is
  // 'binary' (raw PNG), 'cloudflare' ({ result: { image } }) or 'nvidia'
  // ({ artifacts: [{ base64 }] }); image.limit, image.retryAfter, image.status,
  // image.message and image.filtered make it refuse.
  async function serveImage(pid, img, req, res, send) {
    const key = `${pid}:img`;
    const count = (hits[key] = (hits[key] ?? 0) + 1);
    const body = req.method === 'POST' ? await readBody(req) : {};
    seen.push({ pid, image: true, url: req.url, body });
    if (img.key && req.headers.authorization !== `Bearer ${img.key}`) return send(401, { error: { message: 'Invalid token' } });
    if (img.status) return send(img.status, { error: { message: img.message ?? 'image upstream failed' } });
    if (img.limit != null && count > img.limit) {
      return send(img.limitStatus ?? 429, { error: { message: img.message ?? 'Rate limit exceeded' } }, img.retryAfter != null ? { 'retry-after': String(img.retryAfter) } : {});
    }
    if (img.filtered) return send(200, { artifacts: [{ base64: '', finishReason: 'CONTENT_FILTERED' }] });
    if (img.delayMs) await new Promise((r) => setTimeout(r, img.delayMs));
    if (img.make) {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(img.make(body));
    }
    if (img.format === 'cloudflare') return send(200, { result: { image: PNG.toString('base64') }, success: true });
    if (img.format === 'nvidia') return send(200, { artifacts: [{ base64: PNG.toString('base64'), finishReason: 'SUCCESS' }] });
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(PNG);
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const [, pid, v1, ...rest] = url.pathname.split('/');
    const b = behaviors[pid];
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    if (b && v1 === 'img') return serveImage(pid, b.image ?? {}, req, res, send);
    if (!b || v1 !== 'v1') return send(404, { error: { message: 'no such provider' } });
    if (b.key && req.headers.authorization !== `Bearer ${b.key}`) return send(401, { error: { message: 'Invalid API key' } });

    if (rest.join('/') === 'models') {
      return send(200, { object: 'list', data: (b.models ?? ['model-a']).map((m) => (typeof m === 'string' ? { id: m, object: 'model' } : m)) });
    }
    if (rest.join('/') !== 'chat/completions' || req.method !== 'POST') return send(404, { error: { message: 'not found' } });

    const body = await readBody(req);
    const count = (hits[pid] = (hits[pid] ?? 0) + 1);
    seen.push({ pid, body });
    if (b.delayMs) await sleep(b.delayMs);
    if (b.status) return send(b.status, { error: { message: b.message ?? 'upstream exploded' } });
    if (b.noTools && body.tools?.length) return send(400, { error: { message: 'tools are not supported by this model' } });
    if (body.stream && b.streamError) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ error: { message: b.streamError, code: 502 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    if (b.maxTokens && body.max_tokens > b.maxTokens) return send(400, { error: { message: `max_tokens must be less than or equal to ${b.maxTokens}` } });

    const headers = {};
    if (b.rateHeaders && b.limit != null) {
      headers['x-ratelimit-limit-requests'] = String(b.limit);
      headers['x-ratelimit-remaining-requests'] = String(Math.max(0, b.limit - count));
      headers['x-ratelimit-reset-requests'] = `${b.retryAfter ?? 60}s`;
    }
    if (b.limit != null && count > b.limit) {
      if (b.retryAfter != null) headers['retry-after'] = String(b.retryAfter);
      return send(429, { error: { message: b.limitMessage ?? 'Rate limit exceeded' } }, headers);
    }

    let reply = typeof b.reply === 'function' ? b.reply(body, count) : b.reply;
    reply ??= `${pid}/${body.model} says: ${lastUser(body).slice(0, 80)}`;
    if (reply?.raw) return send(200, reply.raw, headers);
    const message = typeof reply === 'string' ? { role: 'assistant', content: reply } : { role: 'assistant', content: reply.content ?? null, tool_calls: reply.tool_calls };
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    const finish = message.tool_calls ? 'tool_calls' : 'stop';
    const base = { id: `mock-${count}`, created: 1, model: body.model };

    if (!body.stream) {
      return send(200, { ...base, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: finish }], usage }, headers);
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', ...headers });
    const emit = (delta, finish_reason = null, extra = {}) =>
      res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`);
    emit({ role: 'assistant', content: '' });
    if (message.tool_calls) {
      message.tool_calls.forEach((t, index) => {
        emit({ tool_calls: [{ index, id: t.id, type: 'function', function: { name: t.function.name, arguments: '' } }] });
        const args = t.function.arguments;
        emit({ tool_calls: [{ index, function: { arguments: args.slice(0, Math.ceil(args.length / 2)) } }] });
        emit({ tool_calls: [{ index, function: { arguments: args.slice(Math.ceil(args.length / 2)) } }] });
      });
    } else {
      for (const word of String(message.content).split(/(?<=\s)/)) {
        emit({ content: word });
        if (b.wordDelayMs) await sleep(b.wordDelayMs);
      }
    }
    emit({}, finish, { usage });
    res.write('data: [DONE]\n\n');
    res.end();
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  server.unref(); // a failed test must not keep the process alive
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    url: base,
    hits,
    seen,
    behaviors,
    /** A provider catalog pointing at this mock. `extra` adds catalog fields per provider id. */
    catalog(extra = {}) {
      return {
        providers: Object.keys(behaviors).map((id) => ({
          id,
          name: id[0].toUpperCase() + id.slice(1),
          baseUrl: `${base}/${id}/v1`,
          keyEnv: `${id.toUpperCase()}_KEY`,
          ...(extra[id] ?? {}),
        })),
      };
    },
    /** Image provider catalog entries pointing at this mock. */
    imageCatalog(ids, extra = {}) {
      return ids.map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1), kind: 'huggingface', url: `${base}/${id}/img/{model}`, keyEnv: `${id.toUpperCase()}_KEY`, models: ['m1'], ...(extra[id] ?? {}) }));
    },
    /** Environment with a key set for every provider (or only the listed ones). */
    env(only = Object.keys(behaviors)) {
      return Object.fromEntries(only.map((id) => [`${id.toUpperCase()}_KEY`, behaviors[id].key ?? 'test-key']));
    },
    close: () => new Promise((r) => server.close(r)),
  };
}
