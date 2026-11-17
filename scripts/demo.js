// Try the whole app without any API keys: `npm run demo`.
// Starts three pretend AI providers on this computer and points AI Compiler
// at them, so you can see routing, rate limits, fallback and the harness work.
// Nothing here talks to the internet and nothing touches your real .env.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore } from '../src/gateway.js';
import { createServer, listen } from '../src/server.js';
import { startMock } from '../test/mock-upstream.js';

const text = (m) => (typeof m?.content === 'string' ? m.content : '');
const systemOf = (body) => body.messages.filter((m) => m.role === 'system').map(text).join('\n');
const question = (body) => text([...body.messages].reverse().find((m) => m.role === 'user')).split('\n---\n')[0].slice(0, 120);

const persona = (name, style) => (body) => {
  const sys = systemOf(body);
  const tools = body.messages.filter((m) => m.role === 'tool').map(text);
  if (/final author in a panel/.test(sys)) {
    return `**Compiled answer** (by ${name}, from three candidates)\n\n| | SQLite | Postgres |\n|---|---|---|\n| Setup | One file, nothing to run | A server to install and look after |\n| Many writers at once | One at a time | Yes |\n| Best for | Small apps and prototypes | Apps that will grow |\n\nStart with SQLite and move when you outgrow it.\n\n*This is a demo, so the answer is canned. The routing, quota counting and fallback are real.*`;
  }
  if (/meticulous reviewer/.test(sys)) return 'The second bullet claims more than the draft supports. State it as a demo limitation.';
  if (/reviewer's notes appear/.test(sys)) return `**Revised answer** (by ${name})\n\n${style} The reviewer's point has been fixed.`;
  if (body.tools?.length && body.tool_choice !== 'none') {
    if (!tools.length) return { tool_calls: [{ id: 'call_demo', type: 'function', function: { name: 'calculator', arguments: JSON.stringify({ expression: '2480 * 0.175' }) } }] };
    return `The calculator tool returned **${tools.at(-1)}**, so 17.5% of 2,480 is ${tools.at(-1)}. (Demo answer from ${name}.)`;
  }
  return `**${name}** here. ${style}\n\nYou asked: "${question(body)}"\n\n\`\`\`bash\ndig example.com +short\n\`\`\`\n\nThis is a pretend provider, so the answer is canned, but the routing, quota counting and fallback you see are the real thing.`;
};

const mock = await startMock({
  alpha: { models: ['alpha-large-70b', 'alpha-mini-8b'], limit: 4, retryAfter: 45, rateHeaders: true, wordDelayMs: 25, reply: persona('Alpha', 'I answer first until my four free requests run out.') },
  beta: { models: ['beta-pro-120b'], wordDelayMs: 25, reply: persona('Beta', 'I take over when Alpha is rate limited.') },
  gamma: { models: ['gamma-flash'], key: 'demo-key', wordDelayMs: 25, reply: persona('Gamma', 'I only work once you save the key "demo-key".') },
});

const dir = mkdtempSync(join(tmpdir(), 'aic-demo-'));
const core = createCore({
  catalogData: mock.catalog({
    alpha: { name: 'Alpha (pretend)', freeTier: 'Pretend provider. Allows 4 requests, then is rate limited for 45 seconds.', signupUrl: 'https://example.com' },
    beta: { name: 'Beta (pretend)', freeTier: 'Pretend provider with no limit. Catches whatever Alpha cannot take.', signupUrl: 'https://example.com' },
    gamma: { name: 'Gamma (pretend)', freeTier: 'Pretend provider with no key yet. Save the key "demo-key" to switch it on, or anything else to see a rejected key.', signupUrl: 'https://example.com' },
  }),
  env: { ALPHA_KEY: 'test-key', BETA_KEY: 'test-key' },
  envFile: join(dir, '.env'),
  dataDir: join(dir, 'data'),
  config: join(dir, 'config.json'),
});

const port = await listen(createServer(core), Number(process.env.AIC_DEMO_PORT) || 4142);
await core.ready();
console.log(`AI Compiler demo is running with three pretend providers.

  Open  http://localhost:${port}

  Things to try:
    - Send five messages: the fifth goes to Beta because Alpha hit its limit.
    - Set Effort to Boost, or to Agent with tools.
    - Open Gamma on the right and save the key "demo-key".

  Press Ctrl+C to stop. Nothing here uses the internet or your real keys.`);
