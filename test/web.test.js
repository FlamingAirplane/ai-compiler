// The browser version (docs/app): built output in sync with its sources,
// the encrypted key vault, and the browser stand-ins for Node modules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { build, BROWSER_CHAT } from '../scripts/build-web.js';
import { ROOT } from '../src/config.js';
import { Vault } from '../web/vault.js';
import * as path from '../web/shims/path.js';

const files = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));

test('docs/app is up to date with its sources (run "npm run build:web" if this fails)', () => {
  const fresh = mkdtempSync(join(tmpdir(), 'aic-web-'));
  const info = build(fresh);
  const built = join(ROOT, 'docs', 'app');
  const want = files(fresh).map((f) => relative(fresh, f)).sort();
  assert.deepEqual(files(built).map((f) => relative(built, f)).sort(), want);
  for (const f of want) assert.equal(readFileSync(join(built, f), 'utf8'), readFileSync(join(fresh, f), 'utf8'), `docs/app/${f} is out of date`);
  assert.deepEqual(info.providers, BROWSER_CHAT);
  assert.ok(!info.hosts.some((h) => h.includes('pollinations')), 'providers that demand a bot check are left out');
});

test('the browser page only runs its own scripts and only talks to the providers', () => {
  const html = readFileSync(join(ROOT, 'docs', 'app', 'index.html'), 'utf8');
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  assert.match(csp, /script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/);
  const connect = csp.match(/connect-src ([^;]+)/)[1].split(' ');
  assert.ok(connect.includes('https://api.groq.com') && connect.includes('https://generativelanguage.googleapis.com'));
  assert.ok(!connect.includes('*') && !connect.some((h) => h === 'https:'), 'no wildcard destinations');
  assert.match(html, /<script src="shims\/process.js"><\/script>\s*<script type="module" src="browser.js"><\/script>\s*<script src="app.js" defer><\/script>/);
  assert.doesNotMatch(html, /\.env file/);
});

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), dump: () => [...m.values()].join('\n') };
}

test('the key vault encrypts keys and only the right passphrase opens it', async () => {
  const storage = memoryStorage();
  const session = memoryStorage();
  const a = new Vault({ storage, session });
  await assert.rejects(a.create('short'), /at least 8/);
  await a.create('correct horse battery');
  await a.update({ GROQ_API_KEY: 'gsk_secret_value', GEMINI_API_KEY: 'AIza_other' });
  assert.equal(storage.dump().includes('gsk_secret_value'), false, 'no key is stored in plain text');
  const saved = JSON.parse(storage.getItem('aic.vault'));
  assert.deepEqual(Object.keys(saved), ['v', 'kdf', 'rounds', 'salt', 'iv', 'data']);
  assert.equal(saved.rounds, 600000);

  // A new tab: nothing in session storage, so it must be unlocked.
  const b = new Vault({ storage, session: memoryStorage() });
  assert.equal(await b.resume(), null);
  assert.equal(await b.unlock('wrong passphrase'), null);
  assert.equal(b.unlocked(), false);
  assert.deepEqual(await b.unlock('correct horse battery'), { GROQ_API_KEY: 'gsk_secret_value', GEMINI_API_KEY: 'AIza_other' });

  // The same tab after a reload resumes without asking.
  const c = new Vault({ storage, session });
  assert.equal((await c.resume()).GROQ_API_KEY, 'gsk_secret_value');

  // Removing a key, then a fresh IV on every save.
  await c.update({ GEMINI_API_KEY: '' });
  assert.notEqual(JSON.parse(storage.getItem('aic.vault')).iv, saved.iv);
  assert.deepEqual(await new Vault({ storage, session: memoryStorage() }).unlock('correct horse battery'), { GROQ_API_KEY: 'gsk_secret_value' });

  c.lock();
  assert.equal(session.getItem('aic.vault.session'), null);
  await assert.rejects(c.update({ X: 'y' }), /locked/);
  c.forget();
  assert.equal(storage.getItem('aic.vault'), null);
});

test('the path stand-in behaves like POSIX paths', () => {
  assert.equal(path.join('/a/b', '../c', 'd.json'), '/a/c/d.json');
  assert.equal(path.resolve('/root/src', '..'), '/root');
  assert.equal(path.dirname('/a/b/c.js'), '/a/b');
  assert.equal(path.basename('/a/b/c.md', '.md'), 'c');
  assert.equal(path.extname('x/y.tar.gz'), '.gz');
  assert.equal(path.relative('/ws', '/ws/src/a.js'), 'src/a.js');
});
