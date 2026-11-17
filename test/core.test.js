import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseEnv, saveEnvVars, merge } from '../src/config.js';
import { parseReset, dayKey, nextDayReset } from '../src/quota.js';
import { normalizeCatalog, rankModels } from '../src/providers.js';
import { classify } from '../src/router.js';
import { createCore } from '../src/gateway.js';
import { collect } from '../src/sse.js';
import { startMock } from './mock-upstream.js';

const T0 = Date.parse('2026-11-16T12:00:00Z');
const ask = (content, extra = {}) => ({ messages: [{ role: 'user', content }], ...extra });

async function setup(behaviors, { catalog = {}, config, now, only } = {}) {
  const mock = await startMock(behaviors);
  const core = createCore({ memory: true, catalogData: mock.catalog(catalog), env: mock.env(only), configData: config, now, skillsDir: join(tmpdir(), 'aic-no-skills') });
  return { mock, core };
}

test('parseReset understands every format providers use', () => {
  const now = 1_000_000;
  assert.equal(parseReset('30', now), now + 30_000);
  assert.equal(parseReset('7.5s', now), now + 7_500);
  assert.equal(parseReset('2m59.5s', now), now + 179_500);
  assert.equal(parseReset('1h2m3s', now), now + 3_723_000);
  assert.equal(parseReset('120ms', now), now + 120);
  assert.equal(parseReset('1794900000', now), 1_794_900_000_000);
  assert.equal(parseReset('1794900000000', now), 1_794_900_000_000);
  assert.equal(parseReset('Mon, 16 Nov 2026 12:00:00 GMT', now), T0);
  assert.equal(parseReset('soon', now), null);
  assert.equal(parseReset('', now), null);
});

test('daily reset follows the provider timezone', () => {
  // 12:00 UTC is 04:00 in Los Angeles in November.
  assert.equal(dayKey(T0, 'UTC'), '2026-11-16');
  assert.equal(dayKey(Date.parse('2026-11-16T03:00:00Z'), 'America/Los_Angeles'), '2026-11-15');
  assert.equal(nextDayReset(T0, 'UTC'), Date.parse('2026-11-17T00:00:00Z'));
  assert.equal(nextDayReset(T0, 'America/Los_Angeles'), Date.parse('2026-11-17T08:00:00Z'));
});

test('saving keys edits .env in place and keeps it private', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'aic-env-')), '.env');
  saveEnvVars(file, { A_KEY: 'one', B_KEY: 'two' });
  saveEnvVars(file, { A_KEY: 'changed', B_KEY: '' });
  assert.deepEqual(parseEnv(readFileSync(file, 'utf8')), { A_KEY: 'changed' });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(parseEnv('# c\nexport X="q v"\nY = 1\n'), { X: 'q v', Y: '1' });
  assert.deepEqual(merge({ a: { b: 1, c: 2 }, d: 3 }, { a: { c: 9 } }), { a: { b: 1, c: 9 }, d: 3 });
});

test('model lists are filtered to chat models and ranked by the catalog preferences', () => {
  const [p] = normalizeCatalog({ providers: [{ id: 'x', baseUrl: 'http://x', prefer: ['^big', 'flash'], maxModels: 4 }] });
  const ranked = rankModels(p, {
    data: [
      { id: 'text-embedding-3' }, { id: 'whisper-large' }, { id: 'llama-guard-4' },
      { id: 'tiny-8b-instant' }, { id: 'big-model-preview' }, { id: 'big-model' },
      { id: 'gem-2.5-flash' }, { id: 'gem-3-flash' }, { id: 'other-120b' }, { id: 'other-70b' },
    ],
  });
  const ids = ranked.map((m) => m.id);
  assert.deepEqual(ids, ['big-model', 'big-model-preview', 'gem-3-flash', 'gem-2.5-flash']);
  assert.deepEqual(ranked.map((m) => m.tier), ['smart', 'smart', 'fast', 'fast']);

  const [free] = normalizeCatalog({ providers: [{ id: 'o', baseUrl: 'http://o', freeSuffix: ':free' }] });
  const out = rankModels(free, { data: [{ id: 'a/paid' }, { id: 'a/free-70b:free', supported_parameters: ['tools'] }, { id: 'b/x:free', supported_parameters: [] }] });
  assert.deepEqual(out.map((m) => [m.id, m.tools]), [['a/free-70b:free', true], ['b/x:free', false]]);

  const [cf] = normalizeCatalog({ providers: [{ id: 'c', baseUrl: 'http://c', modelIdField: 'name' }] });
  assert.deepEqual(rankModels(cf, { result: [{ id: 'uuid-1', name: '@cf/meta/llama-70b' }] }).map((m) => m.id), ['@cf/meta/llama-70b']);
});

test('upstream errors are classified for routing', () => {
  assert.equal(classify(429, ''), 'limited');
  assert.equal(classify(401, ''), 'auth');
  assert.equal(classify(400, 'API key not valid. Please pass a valid API key.'), 'auth');
  assert.equal(classify(402, ''), 'credits');
  assert.equal(classify(404, ''), 'no_model');
  assert.equal(classify(400, 'tools are not supported', true), 'no_tools');
  assert.equal(classify(400, 'invalid value for temperature'), 'bad_request');
  assert.equal(classify(400, "This model's maximum context length is 8192 tokens"), 'too_large');
  assert.equal(classify(413, 'Request too large for model'), 'too_large');
  assert.equal(classify(503, 'overloaded'), 'server');
});

test('a rate-limited provider is skipped and the next one answers', async () => {
  const { mock, core } = await setup({ alpha: { limit: 0, retryAfter: 120 }, beta: {} });
  const first = await core.chat(ask('hello'));
  assert.equal(first.status, 200);
  const body = await first.json();
  assert.match(body.choices[0].message.content, /^beta\//);
  assert.equal(body.aic.provider, 'beta');
  assert.deepEqual(body.aic.attempts.map((a) => [a.provider, a.kind]), [['alpha', 'limited'], ['beta', 'ok']]);

  // Alpha is cooling down, so the second request does not even try it.
  await core.chat(ask('again'));
  assert.equal(mock.hits.alpha, 1);
  assert.equal(mock.hits.beta, 2);

  const status = core.status();
  const alpha = status.providers.find((p) => p.id === 'alpha');
  assert.equal(alpha.state, 'cooling');
  assert.ok(alpha.availableAt > Date.now() + 100_000);
  assert.equal(status.providers.find((p) => p.id === 'beta').today.requests, 2);
  assert.equal(status.providers.find((p) => p.id === 'beta').today.tokens, 30);
  await mock.close();
});

test('a cooled-down provider is used again once its limit resets', async () => {
  let t = T0;
  const { mock, core } = await setup({ alpha: { limit: 1, retryAfter: 60 }, beta: {} }, { now: () => t });
  for (let i = 0; i < 3; i++) await core.chat(ask('q'));
  assert.deepEqual([mock.hits.alpha, mock.hits.beta], [2, 2]);
  mock.behaviors.alpha.limit = 100;
  t += 61_000;
  const r = await (await core.chat(ask('q'))).json();
  assert.equal(r.aic.provider, 'alpha');
  await mock.close();
});

test('rate-limit headers stop requests before the provider has to refuse', async () => {
  const { mock, core } = await setup({ alpha: { limit: 2, rateHeaders: true, retryAfter: 300 }, beta: {} });
  for (let i = 0; i < 4; i++) await core.chat(ask('q'));
  // Two requests fit; the header then said 0 remaining, so no third attempt was wasted.
  assert.deepEqual([mock.hits.alpha, mock.hits.beta], [2, 2]);
  const alpha = core.status().providers.find((p) => p.id === 'alpha');
  assert.equal(alpha.limits['model-a'].buckets.requests.remaining, 0);
  assert.equal(alpha.limits['model-a'].buckets.requests.limit, 2);
  await mock.close();
});

test('a daily-limit message cools the provider until its reset time', async () => {
  let t = T0;
  const { mock, core } = await setup({ alpha: { limit: 0, limitMessage: 'Quota exceeded for requests per day' }, beta: {} }, { now: () => t, catalog: { alpha: { resetTz: 'America/Los_Angeles' } } });
  await core.chat(ask('q'));
  const alpha = core.status().providers.find((p) => p.id === 'alpha');
  assert.equal(alpha.availableAt, Date.parse('2026-11-17T08:00:00Z'));
  assert.equal(alpha.coolingReason, 'daily limit reached');
  await mock.close();
});

test('a rejected key takes the provider out of rotation', async () => {
  const { mock, core } = await setup({ alpha: { key: 'right' }, beta: {} });
  core.env.ALPHA_KEY = 'wrong';
  const r = await (await core.chat(ask('q'))).json();
  assert.equal(r.aic.provider, 'beta');
  assert.equal(core.status().providers.find((p) => p.id === 'alpha').state, 'rejected');
  assert.equal(mock.hits.alpha, undefined, 'the bad key was caught when listing models, not by burning a chat request');

  // Fixing the key brings it straight back.
  await core.setKeys({ ALPHA_KEY: 'right' });
  assert.equal(core.status().providers.find((p) => p.id === 'alpha').state, 'ready');
  assert.equal((await (await core.chat(ask('q'))).json()).aic.provider, 'alpha');
  await assert.rejects(core.setKeys({ NOT_A_KEY: 'x' }), /not a key/);
  await mock.close();
});

test('when every free tier is spent the error says when to come back', async () => {
  const { mock, core } = await setup({ alpha: { limit: 0, retryAfter: 90 }, beta: { limit: 0, retryAfter: 30 } });
  const res = await core.chat(ask('q'));
  assert.equal(res.status, 429);
  const { error } = await res.json();
  assert.equal(error.code, 'all_limited');
  assert.equal(error.attempts.length, 2);
  const wait = Number(res.headers.get('retry-after'));
  assert.ok(wait > 20 && wait <= 30, `retry-after was ${wait}`);

  // Nothing is attempted while everything is cooling.
  const again = await core.chat(ask('q'));
  assert.equal(again.status, 429);
  assert.deepEqual([mock.hits.alpha, mock.hits.beta], [1, 1]);
  await mock.close();
});

test('with no keys at all the error explains what to do', async () => {
  const { mock, core } = await setup({ alpha: {} }, { only: [] });
  const res = await core.chat(ask('q'));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, 'no_providers');
  assert.equal((await core.chat({ messages: [] })).status, 400);
  await mock.close();
});

test('server errors fall through, and repeated bad requests stop early', async () => {
  const a = await setup({ alpha: { status: 503 }, beta: {} });
  assert.equal((await (await a.core.chat(ask('q'))).json()).aic.provider, 'beta');
  await a.mock.close();

  const b = await setup({ a1: { status: 400, message: 'invalid value for temperature' }, a2: { status: 400, message: 'invalid value for temperature' }, a3: { status: 400, message: 'invalid value for temperature' }, a4: {} });
  const res = await b.core.chat(ask('q'));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'upstream_rejected');
  assert.equal(b.mock.hits.a4, undefined);
  await b.mock.close();
});

test('streaming passes the provider stream through and counts its tokens', async () => {
  const { mock, core } = await setup({ alpha: { limit: 0 }, beta: { reply: 'one two three' } });
  const res = await core.chat(ask('q', { stream: true }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-aic-provider'), 'beta');
  const { text, meta, error } = await collect(res);
  assert.equal(error, null);
  assert.equal(text, 'one two three');
  assert.equal(meta.provider, 'beta');
  assert.equal(core.status().providers.find((p) => p.id === 'beta').today.tokens, 15);
  await mock.close();
});

test('model names choose the route', async () => {
  const { mock, core } = await setup(
    { alpha: { models: ['big-70b', 'small-8b'] }, beta: { models: ['other-120b'] } },
  );
  const who = async (model) => {
    const b = await (await core.chat(ask('q', { model }))).json();
    return `${b.aic.provider}/${b.aic.model}`;
  };
  assert.equal(await who('auto'), 'alpha/big-70b');
  assert.equal(await who(undefined), 'alpha/big-70b');
  assert.equal(await who('gpt-4o'), 'alpha/big-70b', 'unknown names fall back to auto');
  assert.equal(await who('auto:fast'), 'alpha/small-8b');
  assert.equal(await who('beta'), 'beta/other-120b');
  assert.equal(await who('alpha/small-8b'), 'alpha/small-8b');
  const ids = core.models().data.map((m) => m.id);
  for (const id of ['auto', 'boost', 'ensemble', 'refine', 'agent', 'panel', 'alpha/big-70b']) assert.ok(ids.includes(id), id);
  await mock.close();
});

test('round-robin strategy spreads requests across providers', async () => {
  const { mock, core } = await setup({ alpha: {}, beta: {}, gamma: {} }, { config: { strategy: 'round-robin' } });
  for (let i = 0; i < 6; i++) await core.chat(ask('q'));
  assert.deepEqual([mock.hits.alpha, mock.hits.beta, mock.hits.gamma], [2, 2, 2]);
  await mock.close();
});

test('a 200 response with an error inside is retried elsewhere', async () => {
  const { mock, core } = await setup({ alpha: { reply: { raw: { error: { message: 'provider returned error' } } } }, beta: {} });
  const b = await (await core.chat(ask('q'))).json();
  assert.equal(b.aic.provider, 'beta');
  await mock.close();
});

test('cancelling a request stops it', async () => {
  const { mock, core } = await setup({ alpha: { delayMs: 2000 } });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  const res = await core.chat(ask('q'), { signal: ac.signal });
  assert.equal(res.status, 499);
  await mock.close();
});
