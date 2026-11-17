// Tests for behaviour that matters once real providers are involved:
// model ranking, error handling, waiting for quota, and shared usage files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeCatalog, rankModels, sizeOf, tierOf, family } from '../src/providers.js';
import { Quota } from '../src/quota.js';
import { createCore } from '../src/gateway.js';
import { collect } from '../src/sse.js';
import { startMock } from './mock-upstream.js';

const T0 = Date.parse('2026-11-16T12:00:00Z');
const ask = (content, extra = {}) => ({ messages: [{ role: 'user', content }], ...extra });

async function setup(behaviors, { catalog = {}, config, now } = {}) {
  const mock = await startMock(behaviors);
  const core = createCore({ memory: true, catalogData: mock.catalog(catalog), env: mock.env(), configData: config, now, skillsDir: join(tmpdir(), 'aic-no-skills') });
  return { mock, core };
}

test('model sizes ignore active-parameter counts and understand trillions', () => {
  assert.equal(sizeOf('llama-3.3-70b'), 70);
  assert.equal(sizeOf('nemotron-3.5-super-vl-120b-a12b'), 120);
  assert.equal(sizeOf('gemma-4-26b-a4b-it'), 26);
  assert.equal(sizeOf('mistral-large-4-1t-a52b'), 1000);
  assert.equal(sizeOf('mixtral-8x7b'), 56);
  assert.equal(sizeOf('lfm-3-1.7b'), 1.7);
  assert.equal(sizeOf('Qwen/Qwen3.8-27B'), 27);
  assert.equal(sizeOf('gemini-3-flash'), 0);

  const [p] = normalizeCatalog({ providers: [{ id: 'x', baseUrl: 'http://x' }] });
  assert.equal(tierOf(p, 'nemotron-3.5-super-vl-120b-a12b'), 'smart', 'a12b is the active count, not the size');
  assert.equal(tierOf(p, 'gpt-4o-mini'), 'fast');
  assert.equal(tierOf(p, 'MiniMax-M3'), 'smart', '"minimax" is not "mini"');
  assert.equal(tierOf(p, 'gemma-4-26b-a4b-it'), 'fast');
  assert.equal(tierOf(p, 'some-new-model'), 'smart');
});

test('dated snapshots of one model are kept once', () => {
  assert.equal(family('mistral-large-2411'), family('mistral-large-latest'));
  assert.equal(family('gpt-4o-2024-08-06'), 'gpt-4o');
  assert.equal(family('gemini-2.0-flash-001'), 'gemini-2.0-flash');
  assert.equal(family('alpha-large-70b'), 'alpha-large-70b');
  const [p] = normalizeCatalog({ providers: [{ id: 'm', baseUrl: 'http://m', prefer: ['^mistral-large-latest$'] }] });
  const ids = rankModels(p, { data: [{ id: 'mistral-large-2411' }, { id: 'mistral-large-latest' }, { id: 'mistral-small-2503' }] }).map((m) => m.id);
  assert.deepEqual(ids, ['mistral-large-latest', 'mistral-small-2503']);
});

test('published quality scores order a provider’s models, and unscored ones land in the middle', () => {
  const [p] = normalizeCatalog({ providers: [{ id: 'o', baseUrl: 'http://o', maxModels: 8 }] });
  const scored = (id, index) => ({ id, benchmarks: { artificial_analysis: { intelligence_index: index } } });
  const ranked = rankModels(p, { data: [scored('a/big-550b', 12), { id: 'b/unknown' }, scored('c/clever-mini', 30), scored('d/weak-31b', 4)] });
  assert.deepEqual(ranked.map((m) => m.id), ['c/clever-mini', 'a/big-550b', 'b/unknown', 'd/weak-31b']);
  assert.deepEqual(ranked.map((m) => m.score), [30, 12, 12, 4]);
});

test('auto tries each provider’s best models before going deeper into one provider', async () => {
  const { mock, core } = await setup({ alpha: { models: ['a-one-70b', 'a-two-70b', 'a-three-70b'] }, beta: { models: ['b-one-70b', 'b-two-70b'] } });
  await core.ready();
  const models = (id) => core.providers.models(core.providers.get(id)).map((m) => `${id}/${m.id}`);
  const [a, b] = [models('alpha'), models('beta')];
  assert.deepEqual(core.router.plan('auto').list.map((c) => `${c.p.id}/${c.model.id}`), [a[0], a[1], b[0], b[1], a[2]]);
  // Naming a provider keeps its own order.
  assert.deepEqual(core.router.plan('alpha').list.map((c) => `${c.p.id}/${c.model.id}`), a);
  await mock.close();
});

test('a model name several providers serve is tried on each of them, then anything else', async () => {
  const { mock, core } = await setup({ alpha: { models: ['x-70b'] }, beta: { models: ['org/shared-70b:free'] }, gamma: { models: ['shared-70b'] } });
  const who = async () => (await (await core.chat(ask('q', { model: 'shared-70b' }))).json()).aic;
  assert.equal((await who()).provider, 'beta');
  mock.behaviors.beta.status = 503;
  assert.equal((await who()).provider, 'gamma');
  mock.behaviors.gamma.status = 503;
  assert.equal((await who()).provider, 'alpha', 'a named model is a preference, not a limit');
  const listed = core.models().data.find((m) => m.id === 'shared-70b');
  assert.match(listed.description, /Served by Beta, Gamma/);
  await mock.close();
});

test('a request too large for one model moves on, and too large for all gives a clear error', async () => {
  const a = await setup({ alpha: { status: 400, message: "This model's maximum context length is 8192 tokens" }, beta: { status: 413, message: 'Request too large for model' }, gamma: {} });
  const body = await (await a.core.chat(ask('q'))).json();
  assert.equal(body.aic.provider, 'gamma');
  assert.deepEqual(body.aic.attempts.map((x) => x.kind), ['too_large', 'too_large', 'ok']);
  assert.equal(a.core.quota.cooling('alpha', 'model-a'), null, 'too large says nothing about the model, so it is not rested');
  await a.mock.close();

  const b = await setup({ alpha: { status: 413, message: 'Request too large' }, beta: { status: 400, message: 'prompt is too long' } });
  const res = await b.core.chat(ask('q'));
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error.code, 'too_large');
  await b.mock.close();
});

test('a model left out of the free tier ("limit: 0") rests until tomorrow', async () => {
  const t = T0;
  const message = 'Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: pro';
  const { mock, core } = await setup({ alpha: { limit: 0, limitMessage: message, retryAfter: 30 }, beta: {} }, { now: () => t, catalog: { alpha: { resetTz: 'America/Los_Angeles' } } });
  await core.chat(ask('q'));
  const c = core.quota.cooling('alpha', 'model-a');
  assert.equal(c.until, Date.parse('2026-11-17T08:00:00Z'));
  assert.equal(c.reason, 'not included in your free tier');
  await mock.close();
});

test('daily limits: fixed-reset providers wait for midnight, rolling ones trust the retry time', async () => {
  const t = T0;
  const daily = { limit: 0, limitMessage: 'Rate limit exceeded: free-models-per-day', retryAfter: 30 };
  const fixed = await setup({ alpha: { ...daily }, beta: {} }, { now: () => t, catalog: { alpha: { dailyReset: 'fixed' } } });
  await fixed.core.chat(ask('q'));
  assert.equal(fixed.core.quota.cooling('alpha', 'model-a').until, Date.parse('2026-11-17T00:00:00Z'));
  await fixed.mock.close();

  const rolling = await setup({ alpha: { ...daily }, beta: {} }, { now: () => t });
  await rolling.core.chat(ask('q'));
  const c = rolling.core.quota.cooling('alpha', 'model-a');
  assert.equal(c.until, t + 30_000);
  assert.equal(c.reason, 'daily limit reached');
  await rolling.mock.close();
});

test('an empty reply, or a stream that opens with an error, is retried on another model', async () => {
  const a = await setup({ alpha: { reply: '' }, beta: { reply: 'a real answer' } });
  const plain = await (await a.core.chat(ask('q'))).json();
  assert.equal(plain.choices[0].message.content, 'a real answer');
  const streamedEmpty = await a.core.chat(ask('q', { stream: true, model: 'alpha' }));
  // Only alpha was allowed and it keeps answering with nothing.
  assert.match(JSON.stringify(await streamedEmpty.json()), /unusable reply|rate limited|resting/);
  await a.mock.close();

  const b = await setup({ alpha: { streamError: 'upstream overloaded' }, beta: { reply: 'streamed fine' } });
  const res = await b.core.chat(ask('q', { stream: true }));
  assert.equal(res.headers.get('x-aic-provider'), 'beta');
  const { text, error } = await collect(res);
  assert.equal(error, null);
  assert.equal(text, 'streamed fine');
  assert.match(b.core.status().providers.find((p) => p.id === 'alpha').lastError.message, /upstream overloaded/);
  await b.mock.close();
});

test('when the only free tier is back within seconds, the request waits instead of failing', async () => {
  const { mock, core } = await setup({ alpha: { limit: 1, retryAfter: 1 } });
  await core.chat(ask('first'));
  setTimeout(() => (mock.behaviors.alpha.limit = 100), 300);
  const t0 = Date.now();
  const res = await core.chat(ask('second'));
  assert.equal(res.status, 200);
  assert.ok(Date.now() - t0 >= 900, 'it waited for the limit to reset');

  // Waiting is capped: a long rest still fails at once.
  const slow = await setup({ alpha: { limit: 0, retryAfter: 120 } });
  const t1 = Date.now();
  assert.equal((await slow.core.chat(ask('q'))).status, 429);
  assert.ok(Date.now() - t1 < 2000);
  await slow.mock.close();
  await mock.close();
});

test('usage from several processes adds up instead of overwriting', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'aic-usage-')), 'usage.json');
  const a = new Quota({ file });
  const b = new Quota({ file });
  a.countRequest('p', 'm');
  a.countRequest('p', 'm');
  a.addTokens('p', 'm', 10);
  b.countRequest('p', 'm');
  b.addTokens('p', 'm', 5);
  b.cool('p', 'm', Date.now() + 60_000, 'rate limited');
  a.flush();
  b.flush();

  const c = new Quota({ file });
  const v = c.view('p');
  assert.deepEqual([v.requests, v.tokens, v.total.requests], [3, 15, 3]);
  a.sync(true);
  assert.equal(a.cooling('p', 'm').reason, 'rate limited', 'one process sees a cooldown another set');
  assert.equal(existsSync(`${file}.lock`), false);

  // A lock left behind by a crashed process does not block saving forever.
  writeFileSync(`${file}.lock`, '');
  const old = new Date(Date.now() - 60_000);
  utimesSync(`${file}.lock`, old, old);
  a.countRequest('p', 'm');
  a.flush();
  assert.equal(new Quota({ file }).view('p').requests, 4);
});

test('a running cooldown survives a late success from a request already in flight', () => {
  const q = new Quota();
  q.cool('p', '*', Date.now() + 3_600_000, 'daily limit reached');
  q.countRequest('p', 'm');
  assert.equal(q.cooling('p', 'm').reason, 'daily limit reached');
});

test('the self-test checks every provider and the activity log records it', async () => {
  const { mock, core } = await setup({ alpha: {}, beta: { limit: 0, retryAfter: 600 } });
  const results = await core.testAll();
  const byId = Object.fromEntries(results.map((r) => [r.provider, r]));
  assert.equal(byId.alpha.ok, true);
  assert.equal(byId.alpha.model, 'model-a');
  assert.match(byId.alpha.reply, /alpha\/model-a says/);
  assert.equal(byId.beta.ok, false);
  assert.match(byId.beta.message, /Rate limit exceeded\. Back at/);
  await assert.rejects(core.testProvider('nope'), /no provider called "nope"/);

  await core.chat(ask('hello', { aic: { source: 'mcp' } }));
  const activity = core.status().activity;
  assert.equal(activity[0].source, 'mcp');
  assert.equal(activity[0].provider, 'alpha');
  assert.equal(activity[0].ok, true);
  assert.deepEqual(activity.slice(1).map((a) => a.source).sort(), ['check', 'check']);
  await mock.close();
});
