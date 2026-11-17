import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCore } from '../src/gateway.js';
import { createServer, listen } from '../src/server.js';
import { handleMessage } from '../src/mcp.js';
import { parseSize, sniff } from '../src/images.js';
import { startMock, PNG } from './mock-upstream.js';

const tmp = (name) => mkdtempSync(join(tmpdir(), `aic-${name}-`));

async function setup(behaviors, { images = Object.keys(behaviors), extra = {}, config } = {}) {
  const mock = await startMock(behaviors);
  const imageDir = tmp('images');
  const core = createCore({
    memory: true,
    imageDir,
    catalogData: { providers: [], imageProviders: mock.imageCatalog(images, extra) },
    env: mock.env(),
    configData: config,
    skillsDir: join(tmpdir(), 'aic-no-skills'),
  });
  return { mock, core, imageDir };
}

test('sizes are clamped and rounded, and images are recognised by their bytes', () => {
  assert.deepEqual(parseSize('1024x768'), { width: 1024, height: 768 });
  assert.deepEqual(parseSize('100x5000'), { width: 256, height: 1536 });
  assert.deepEqual(parseSize('1000×1000'), { width: 1024, height: 1024 });
  assert.deepEqual(parseSize(undefined), { width: 1024, height: 1024 });
  assert.equal(sniff(PNG), 'image/png');
  assert.equal(sniff(Buffer.from('{"error":"nope", "padding": "................................"}')), null);
});

test('a rate-limited image provider is rested and the next one makes the image', async () => {
  const { mock, core, imageDir } = await setup({ alpha: { image: { limit: 0, retryAfter: 120 } }, beta: { image: { format: 'cloudflare' } } });
  const out = await core.generateImages({ prompt: 'a red apple', size: '512x512' });
  assert.equal(out.images.length, 1);
  const img = out.images[0];
  assert.equal(img.provider, 'beta');
  assert.equal(img.mime, 'image/png');
  assert.deepEqual([img.width, img.height], [512, 512]);
  assert.deepEqual(Buffer.from(img.b64, 'base64'), PNG);
  assert.ok(existsSync(join(imageDir, img.file)), 'saved to the image folder');
  assert.deepEqual(out.attempts.map((a) => [a.provider, a.kind]), [['alpha', 'limited'], ['beta', 'ok']]);
  // The request sent the size the caller asked for.
  assert.deepEqual(mock.seen.find((s) => s.pid === 'beta').body.parameters, { width: 512, height: 512 });

  // Alpha is resting, so the next image does not try it.
  await core.generateImages({ prompt: 'again' });
  assert.equal(mock.hits['alpha:img'], 1);
  const status = core.status().images.providers;
  assert.equal(status.find((p) => p.id === 'alpha').state, 'cooling');
  assert.equal(status.find((p) => p.id === 'beta').today.requests, 2);
  await mock.close();
});

test('each provider kind is asked and read in its own format', async () => {
  const { mock, core } = await setup(
    { cf: { image: { format: 'cloudflare' } }, nv: { image: { format: 'nvidia' } }, pol: { image: {} } },
    { extra: { cf: { kind: 'cloudflare', models: ['@cf/black-forest-labs/flux-1-schnell'] }, nv: { kind: 'nvidia', models: ['org/flux.1-schnell'] }, pol: { kind: 'pollinations', url: '', models: ['default'] } } },
  );
  // Point the keyless one at the mock too.
  core.images.get('pol').url = `${mock.url}/pol/img/{prompt}`;
  for (const id of ['cf', 'nv', 'pol']) {
    const out = await core.generateImages({ prompt: 'a cat & a dog', model: id, seed: 7 });
    assert.equal(out.images[0].provider, id);
  }
  const cf = mock.seen.find((s) => s.pid === 'cf');
  assert.match(cf.url, /\/cf\/img\/@cf\/black-forest-labs\/flux-1-schnell$/);
  assert.deepEqual(cf.body, { prompt: 'a cat & a dog', steps: 8, seed: 7 });
  assert.deepEqual(mock.seen.find((s) => s.pid === 'nv').body, { prompt: 'a cat & a dog', width: 1024, height: 1024, seed: 7, steps: 4 });
  const pol = new URL(mock.seen.find((s) => s.pid === 'pol').url, mock.url);
  assert.equal(decodeURIComponent(pol.pathname.split('/').pop()), 'a cat & a dog');
  assert.equal(pol.searchParams.get('private'), 'true');
  assert.equal(pol.searchParams.get('seed'), '7');
  await mock.close();
});

test('a prompt refused by the safety filter stops after two providers say no', async () => {
  const { mock, core } = await setup({ a: { image: { format: 'nvidia', filtered: true } }, b: { image: { status: 400, message: 'prompt violates policy' } }, c: { image: {} } });
  await assert.rejects(core.generateImages({ prompt: 'something not allowed' }), (err) => err.failure.code === 'refused' && /policy/.test(err.message));
  assert.equal(mock.hits['c:img'], undefined);
  await mock.close();
});

test('a busy free service that says "retry after" is waited for', async () => {
  const { mock, core } = await setup({ pol: { image: { limit: 1, limitStatus: 503, message: 'Free limit reached: 1 image every 45 seconds per IP. Retry after 1s' } } });
  await core.generateImages({ prompt: 'first' });
  setTimeout(() => (mock.behaviors.pol.image.limit = 100), 300);
  const t0 = Date.now();
  const out = await core.generateImages({ prompt: 'second' });
  assert.equal(out.images.length, 1);
  assert.ok(Date.now() - t0 >= 900, 'it waited about a second');
  await mock.close();
});

test('no keys, a bad prompt, and an OpenAI model name are all handled', async () => {
  const { mock, core } = await setup({ alpha: { image: {} } });
  delete core.env.ALPHA_KEY;
  await assert.rejects(core.generateImages({ prompt: 'x' }), (err) => err.failure.code === 'no_providers');
  core.env.ALPHA_KEY = 'test-key';
  await assert.rejects(core.generateImages({ prompt: '   ' }), (err) => err.failure.code === 'invalid_request');
  const out = await core.generateImages({ prompt: 'x', model: 'dall-e-3', n: 9 });
  assert.equal(out.images.length, 4, 'n is capped at 4');
  assert.equal(core.status().activity[0].mode, 'image');
  await mock.close();
});

test('the API, the image files, the MCP tool and the CLI all work', async () => {
  const { mock, core, imageDir } = await setup({ alpha: { image: {} } });
  const server = createServer(core);
  const port = await listen(server, 0);
  server.unref();
  const base = `http://127.0.0.1:${port}`;
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const b64 = await (await post('/v1/images/generations', { prompt: 'a lighthouse', n: 2 })).json();
  assert.equal(b64.data.length, 2);
  assert.deepEqual(Buffer.from(b64.data[0].b64_json, 'base64'), PNG);
  assert.equal(b64.aic.images[0].provider, 'alpha');

  const byUrl = await (await post('/v1/images/generations', { prompt: 'a lighthouse', response_format: 'url' })).json();
  const file = await fetch(byUrl.data[0].url);
  assert.equal(file.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG);

  const list = (await (await fetch(`${base}/api/images`)).json()).images;
  assert.equal(list.length, 3);
  assert.equal((await fetch(`${base}/images/..%2Fusage.json`)).status, 404);
  const after = await (await post('/api/images/delete', { file: list[0].file })).json();
  assert.equal(after.images.length, 2);
  assert.equal(existsSync(join(imageDir, list[0].file)), false);

  const bad = await post('/v1/images/generations', { prompt: '' });
  assert.equal(bad.status, 400);

  const tools = (await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { port })).result.tools.map((t) => t.name);
  assert.ok(tools.includes('generate_image'));
  const made = (await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'generate_image', arguments: { prompt: 'a fox' } } }, { port })).result;
  assert.equal(made.content[0].type, 'image');
  assert.equal(made.content[0].mimeType, 'image/png');
  assert.match(made.content[1].text, /Made with Alpha \(m1\), 1024x1024/);

  const out = tmp('cli');
  const cli = await new Promise((resolve) => execFile(process.execPath, [join(import.meta.dirname, '..', 'src', 'cli.js'), 'image', 'a small boat', '-n', '2', '-o', out, '--port', String(port)], { timeout: 20000 }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr })));
  assert.equal(cli.code, 0, cli.stderr);
  const paths = cli.stdout.trim().split('\n');
  assert.deepEqual(paths.map((p) => p.split('/').pop()), ['a-small-boat-1.png', 'a-small-boat-2.png']);
  assert.deepEqual(readFileSync(paths[0]), PNG);
  await mock.close();
});
