// The local HTTP server: an OpenAI-compatible API, an Anthropic-compatible
// API, a small management API for the dashboard, and the dashboard itself.

import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { extname, join, normalize, sep } from 'node:path';
import { APP, VERSION } from './config.js';
import { anthropicError, fromOpenAI, streamToAnthropic, toOpenAI } from './anthropic.js';
import { estimateTokens } from './sse.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const MAX_BODY = 32 * 1024 * 1024;
// The page may only talk to this server and run this server's script. Model
// output is rendered as text, and this is the backstop if that ever fails.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const fail = (code, message) => ({ error: { message, type: 'aic_error', code } });

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('The request body is too large.'), { status: 413 }));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on('error', reject);
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(Object.assign(new Error('The request body is not valid JSON.'), { status: 400 }));
      }
    });
  });
}

/** Write a web Response out through a Node response, streaming the body. */
async function pipe(res, response, signal) {
  const headers = { 'cache-control': 'no-store' };
  response.headers.forEach((v, k) => (headers[k] = v));
  res.writeHead(response.status, headers);
  if (!response.body) return res.end();
  res.flushHeaders();
  try {
    for await (const chunk of response.body) {
      if (!res.write(chunk)) await once(res, 'drain', { signal });
    }
  } catch {
    /* the client left or the provider dropped the stream: nothing more to send */
  }
  res.end();
}

export function createServer(core, { allowedHosts = [] } = {}) {
  const allowed = new Set([...LOCAL_HOSTS, ...allowedHosts.map((h) => h.toLowerCase())]);
  const publicDir = core.paths.publicDir;

  async function serveStatic(res, path) {
    const file = normalize(join(publicDir, path === '/' ? 'index.html' : path));
    if (!file.startsWith(publicDir + sep)) return sendJson(res, 404, fail('not_found', 'Not found.'));
    try {
      const data = await readFile(file);
      res.writeHead(200, {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
        'content-security-policy': CSP,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      });
      res.end(data);
    } catch {
      sendJson(res, 404, fail('not_found', 'Not found.'));
    }
  }

  async function messages(res, body, signal) {
    const oa = toOpenAI(body, core.config.anthropicModels);
    oa.aic = { source: 'anthropic' };
    const model = String(body.model ?? 'auto');
    const response = await core.chat(oa, { signal });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      const retry = response.headers.get('retry-after');
      return sendJson(res, response.status, anthropicError(response.status, data?.error?.message ?? 'The request failed.'), retry ? { 'retry-after': retry } : {});
    }
    if ((response.headers.get('content-type') ?? '').includes('event-stream')) {
      const stream = streamToAnthropic(response.body, model, estimateTokens(oa.messages));
      return pipe(res, new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' } }), signal);
    }
    return sendJson(res, 200, fromOpenAI(await response.json(), model));
  }

  async function handle(req, res) {
    const path = new URL(req.url, 'http://local').pathname;

    // This server holds your API keys and spends your quota, so it only
    // answers requests addressed to this computer and refuses requests that
    // come from other websites open in your browser.
    const hostname = String(req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
    if (!allowed.has(hostname)) return sendJson(res, 403, fail('forbidden_host', 'This server only answers requests addressed to localhost.'));
    const origin = req.headers.origin;
    if (origin) {
      let same = false;
      try {
        same = new URL(origin).host === req.headers.host;
      } catch {
        /* an unparseable origin is not ours */
      }
      if (!same) return sendJson(res, 403, fail('forbidden_origin', 'Requests from other websites are not allowed.'));
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (path === '/api/health') return sendJson(res, 200, { app: APP, version: VERSION });
      if (path === '/api/status') {
        core.ready().catch(() => {});
        return sendJson(res, 200, core.status());
      }
      if (path === '/api/skills') return sendJson(res, 200, { skills: core.skillList() });
      if (path === '/v1/models') {
        await core.ready();
        return sendJson(res, 200, core.models());
      }
      return serveStatic(res, path);
    }
    if (req.method !== 'POST') return sendJson(res, 405, fail('method_not_allowed', 'Use GET or POST.'));
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return sendJson(res, 415, fail('unsupported_media_type', 'Send JSON with Content-Type: application/json.'));

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, err.status ?? 400, fail('invalid_request', err.message));
    }
    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) ac.abort();
    });

    switch (path) {
      case '/v1/chat/completions':
        if (body && typeof body === 'object' && !body.aic?.source) body.aic = { ...(body.aic ?? {}), source: 'api' };
        return pipe(res, await core.chat(body, { signal: ac.signal }), ac.signal);
      case '/v1/messages':
        return messages(res, body, ac.signal);
      case '/v1/messages/count_tokens':
        return sendJson(res, 200, { input_tokens: estimateTokens([body.system, body.messages, body.tools]) });
      case '/api/keys':
        try {
          return sendJson(res, 200, await core.setKeys(body.vars));
        } catch (err) {
          if (err.failure) return sendJson(res, err.failure.status, fail(err.failure.code, err.failure.message));
          throw err;
        }
      case '/api/refresh':
        return sendJson(res, 200, await core.refresh());
      case '/api/test':
        try {
          const results = body.provider ? [await core.testProvider(String(body.provider), { signal: ac.signal })] : await core.testAll({ signal: ac.signal });
          return sendJson(res, 200, { results, status: core.status() });
        } catch (err) {
          if (err.failure) return sendJson(res, err.failure.status, fail(err.failure.code, err.failure.message));
          throw err;
        }
      default:
        return sendJson(res, 404, fail('not_found', 'Not found.'));
    }
  }

  return createHttpServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('[aic] request failed:', err);
      if (!res.headersSent) sendJson(res, 500, fail('internal_error', 'Something went wrong inside the server.'));
      else res.end();
    });
  });
}

export function listen(server, port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}
