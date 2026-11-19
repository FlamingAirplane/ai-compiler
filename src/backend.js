// The CLI and the MCP server use whichever is available: the running local
// server (so everything shares one set of quota counters), or, if it is not
// running, the core loaded directly into this process.

import { APP, DEFAULT_PORT } from './config.js';
import { createCore } from './gateway.js';

let localCore = null;

export async function getBackend({ port = DEFAULT_PORT, coreOptions = {} } = {}) {
  const base = `http://127.0.0.1:${port}`;
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) });
    if ((await res.json()).app === APP) {
      const get = (path) => fetch(base + path).then((r) => r.json());
      return {
        kind: 'server',
        where: base,
        chat: (body, { signal } = {}) => fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal }),
        status: () => get('/api/status'),
        models: () => get('/v1/models'),
        skills: async () => (await get('/api/skills')).skills,
        image: async (body) => {
          const res = await fetch(`${base}/v1/images/generations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, response_format: 'b64_json' }) });
          const data = await res.json();
          if (!res.ok) throw Object.assign(new Error(data?.error?.message ?? `HTTP ${res.status}`), { retryAt: data?.error?.retry_at });
          return { ...data.aic, images: data.aic.images.map((meta, i) => ({ ...meta, b64: data.data[i].b64_json })) };
        },
        setKeys: async (vars) => {
          const res = await fetch(`${base}/api/keys`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ vars }) });
          const data = await res.json();
          if (!res.ok) throw new Error(data?.error?.message ?? `HTTP ${res.status}`);
          return data;
        },
        test: async (provider) => {
          const res = await fetch(`${base}/api/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(provider ? { provider } : {}) });
          const data = await res.json();
          if (!res.ok) throw new Error(data?.error?.message ?? `HTTP ${res.status}`);
          return data.results;
        },
        close() {},
      };
    }
  } catch {
    /* no server running: fall through to the in-process core */
  }
  localCore ??= createCore(coreOptions);
  const core = localCore;
  await core.ready();
  return {
    kind: 'local',
    where: 'this process',
    chat: (body, opts) => core.chat(body, opts),
    status: async () => core.status(),
    models: async () => core.models(),
    skills: async () => core.skillList(),
    test: async (provider) => (provider ? [await core.testProvider(provider)] : core.testAll()),
    setKeys: async (vars) => {
      try {
        return await core.setKeys(vars);
      } catch (err) {
        throw new Error(err.failure?.message ?? err.message);
      }
    },
    image: async (body) => {
      try {
        return await core.generateImages(body);
      } catch (err) {
        throw Object.assign(new Error(err.message), { retryAt: err.failure?.retryAt ? new Date(err.failure.retryAt).toISOString() : null });
      }
    },
    close: () => core.close(),
  };
}
