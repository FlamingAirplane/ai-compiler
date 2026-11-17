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
    close: () => core.close(),
  };
}
