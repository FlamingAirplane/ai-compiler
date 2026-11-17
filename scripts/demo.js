// Try the whole app without any API keys: `npm run demo`.
// Starts three pretend AI providers on this computer and points AI Compiler
// at them, so you can see routing, rate limits, fallback and the harness work.
// Nothing here talks to the internet and nothing touches your real .env.

import { mkdtempSync } from 'node:fs';
import zlib from 'node:zlib';
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

/** A small PNG landscape whose colours come from the prompt, standing in for a real image model. */
function landscape(body) {
  const prompt = String(body?.inputs ?? 'demo');
  const w = body?.parameters?.width ?? 512;
  const h = body?.parameters?.height ?? 512;
  let seed = [...prompt].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const hue = seed % 360;
  const rgb = (hDeg, s, l) => {
    const k = (n) => (n + hDeg / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    return [0, 8, 4].map((n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)))));
  };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  const sun = { x: w * (0.25 + (seed % 50) / 100), y: h * 0.32, r: Math.min(w, h) * 0.09 };
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const hill1 = h * 0.62 + Math.sin(x / w * 5 + seed) * h * 0.06;
      const hill2 = h * 0.74 + Math.sin(x / w * 3 + seed / 7) * h * 0.05;
      let c;
      if (y > hill2) c = rgb((hue + 140) % 360, 0.35, 0.25 + (y - hill2) / h * 0.2);
      else if (y > hill1) c = rgb((hue + 110) % 360, 0.4, 0.42);
      else if ((x - sun.x) ** 2 + (y - sun.y) ** 2 < sun.r ** 2) c = rgb((hue + 40) % 360, 0.9, 0.78);
      else c = rgb(hue, 0.55, 0.82 - (y / h) * 0.35);
      raw.set(c, y * (w * 3 + 1) + 1 + x * 3);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const mock = await startMock({
  alpha: { models: ['alpha-large-70b', 'alpha-mini-8b'], limit: 4, retryAfter: 45, rateHeaders: true, wordDelayMs: 25, reply: persona('Alpha', 'I answer first until my four free requests run out.') },
  beta: { models: ['beta-pro-120b'], wordDelayMs: 25, reply: persona('Beta', 'I take over when Alpha is rate limited.') },
  gamma: { models: ['gamma-flash'], key: 'demo-key', wordDelayMs: 25, reply: persona('Gamma', 'I only work once you save the key "demo-key".') },
  painter: { image: { make: landscape, delayMs: 1500 } },
});

const dir = mkdtempSync(join(tmpdir(), 'aic-demo-'));
const chat = mock.catalog({
  alpha: { name: 'Alpha (pretend)', freeTier: 'Pretend provider. Allows 4 requests, then is rate limited for 45 seconds.', signupUrl: 'https://example.com' },
  beta: { name: 'Beta (pretend)', freeTier: 'Pretend provider with no limit. Catches whatever Alpha cannot take.', signupUrl: 'https://example.com' },
  gamma: { name: 'Gamma (pretend)', freeTier: 'Pretend provider with no key yet. Save the key "demo-key" to switch it on, or anything else to see a rejected key.', signupUrl: 'https://example.com' },
});
const core = createCore({
  catalogData: {
    providers: chat.providers.filter((p) => p.id !== 'painter'),
    imageProviders: mock.imageCatalog(['painter'], { painter: { name: 'Painter (pretend)', models: ['landscape-1'], keyEnv: undefined, signupUrl: 'https://example.com', freeTier: 'Pretend image provider. Draws a landscape whose colours depend on the prompt.' } }),
  },
  imageDir: join(dir, 'images'),
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
    - Open the Images tab and make a picture.

  Press Ctrl+C to stop. Nothing here uses the internet or your real keys.`);
