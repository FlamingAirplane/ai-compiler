// Builds the browser version into docs/app, for GitHub Pages: `npm run build:web`.
//
// The browser version runs the same core code as the local server. Node-only
// modules are swapped for small browser stand-ins with an import map, and
// only providers that accept requests from web pages are included.

import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../src/config.js';

// Providers whose APIs answer browser requests (checked in November 2026).
// Pollinations is left out: from a web page it demands a Cloudflare Turnstile
// (bot check) token, which a page should not try to get around.
export const BROWSER_CHAT = ['gemini', 'groq', 'cerebras', 'openrouter', 'mistral', 'cohere', 'huggingface'];
export const BROWSER_IMAGES = ['huggingface'];
// The core modules the browser version needs, copied unchanged.
export const CORE = ['config', 'providers', 'quota', 'router', 'harness', 'sse', 'skills', 'tools', 'images', 'gateway'];
const NODE = ['fs', 'path', 'url', 'crypto', 'os', 'http', 'https', 'dns', 'net', 'zlib', 'child_process'];
const EXTRA_HOSTS = ['https://*.wikipedia.org', 'https://api.tavily.com'];

const OUT = join(ROOT, 'docs', 'app');
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');

export function build(out = OUT) {
  rmSync(out, { recursive: true, force: true });
  for (const dir of ['core', 'shims']) mkdirSync(join(out, dir), { recursive: true });

  for (const m of CORE) copyFileSync(join(ROOT, 'src', `${m}.js`), join(out, 'core', `${m}.js`));
  for (const f of readdirSync(join(ROOT, 'web', 'shims'))) copyFileSync(join(ROOT, 'web', 'shims', f), join(out, 'shims', f));
  for (const f of ['browser.js', 'vault.js', 'imagedb.js', 'browser.css']) copyFileSync(join(ROOT, 'web', f), join(out, f));
  copyFileSync(join(ROOT, 'public', 'app.js'), join(out, 'app.js'));

  const catalog = JSON.parse(read('providers.json'));
  const providers = catalog.providers.filter((p) => BROWSER_CHAT.includes(p.id));
  const imageProviders = (catalog.imageProviders ?? []).filter((p) => BROWSER_IMAGES.includes(p.id));
  writeFileSync(join(out, 'core', 'catalog.json'), `${JSON.stringify({ providers, imageProviders }, null, 1)}\n`);

  const skills = readdirSync(join(ROOT, 'skills'))
    .filter((f) => f.endsWith('.md') && !/^readme\.md$/i.test(f))
    .sort()
    .map((f) => ({ name: f.replace(/\.md$/, ''), text: read('skills', f) }));
  writeFileSync(join(out, 'core', 'skills.json'), `${JSON.stringify(skills)}\n`);

  // Every host the page may talk to: nothing else is allowed, so even injected
  // code could not send the keys anywhere but the providers they belong to.
  const hosts = new Set(EXTRA_HOSTS);
  for (const p of [...providers, ...imageProviders]) {
    for (const u of [p.baseUrl, p.modelsUrl, p.keyCheckUrl, p.url]) if (u) hosts.add(new URL(u.replace(/\{[^}]+\}/g, 'x')).origin);
  }
  const importmap = JSON.stringify({ imports: Object.fromEntries(NODE.map((m) => [`node:${m}`, `./shims/${m}.js`])) });
  const hash = createHash('sha256').update(importmap).digest('base64');
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'sha256-${hash}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    `connect-src 'self' ${[...hosts].sort().join(' ')}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');

  let html = read('public', 'index.html');
  const swap = (a, b) => {
    if (!html.includes(a)) throw new Error(`build-web: could not find ${JSON.stringify(a.slice(0, 60))} in public/index.html`);
    html = html.replace(a, b);
  };
  swap('<title>AI Compiler</title>', `<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="referrer" content="no-referrer">
<title>AI Compiler (web)</title>
<meta name="description" content="AI Compiler in your browser: free AI tiers behind one chat page, with your keys encrypted on this device.">
<link rel="stylesheet" href="browser.css">
<script type="importmap">${importmap}</script>`);
  swap('<script src="/app.js" defer></script>', '<script src="shims/process.js"></script>\n<script type="module" src="browser.js"></script>\n<script src="app.js" defer></script>');
  swap('<main>', `<div class="web-banner">Browser version: everything runs in this page and talks to the AI providers directly. ${providers.length} chat providers work here; <a href="https://github.com/FlamingAirplane/ai-compiler#start">run it on your computer</a> for all of them, the API and Claude Code. <a href="../">About</a></div>\n<main>`);
  html = html.replace(/<p class="fine">[\s\S]*?<\/p>/, '<p class="fine">Your keys are encrypted with your passphrase and stored only in this browser. They are sent only to the provider they belong to; this page is not allowed to contact any other site. Use one key per provider, from your own account. Some free tiers keep prompts for training, so do not paste secrets.</p>');
  writeFileSync(join(out, 'index.html'), html);

  writeFileSync(join(out, 'GENERATED.txt'), 'Built by `npm run build:web` from src/, web/, public/, skills/ and providers.json. Edit those, not these files.\n');
  return { providers: providers.map((p) => p.id), imageProviders: imageProviders.map((p) => p.id), hosts: [...hosts] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = build();
  console.log(`Built docs/app: chat ${r.providers.join(', ')}; images ${r.imageProviders.join(', ')}.`);
}
