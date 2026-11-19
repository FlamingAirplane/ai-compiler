import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCore } from '../src/gateway.js';
import { createServer, listen } from '../src/server.js';
import { handleMessage } from '../src/mcp.js';
import { toOpenAI, fromOpenAI, mapModel } from '../src/anthropic.js';
import { startMock } from './mock-upstream.js';

const SKILLS = join(import.meta.dirname, '..', 'skills');

async function setup(behaviors, { skillsDir = join(tmpdir(), 'aic-no-skills') } = {}) {
  const mock = await startMock(behaviors);
  const core = createCore({ memory: true, catalogData: mock.catalog(), env: mock.env(), skillsDir });
  const server = createServer(core);
  const port = await listen(server, 0);
  server.unref();
  const base = `http://127.0.0.1:${port}`;
  const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { mock, core, port, base, post };
}

const rawRequest = (port, { path = '/api/health', headers = {} }) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });

test('the server serves the dashboard, status and an OpenAI-compatible API', async () => {
  const { base, post } = await setup({ alpha: { reply: 'hello there' } });
  assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), { app: 'ai-compiler', version: '0.1.0' });

  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(await page.text(), /<title>AI Compiler<\/title>/);
  assert.equal((await fetch(`${base}/app.js`)).status, 200);
  assert.equal((await fetch(`${base}/..%2f..%2fpackage.json`)).status, 404);

  const status = await (await fetch(`${base}/api/status`)).json();
  assert.equal(status.providers[0].id, 'alpha');
  assert.ok((await (await fetch(`${base}/v1/models`)).json()).data.some((m) => m.id === 'alpha/model-a'));

  const plain = await (await post('/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] })).json();
  assert.equal(plain.choices[0].message.content, 'hello there');
  assert.equal(plain.aic.provider, 'alpha');

  const streamed = await post('/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }], stream: true });
  assert.match(streamed.headers.get('content-type'), /event-stream/);
  const raw = await streamed.text();
  assert.match(raw, /^: aic \{"event":"route"/);
  assert.match(raw, /"content":"hello "/);
  assert.match(raw, /data: \[DONE\]/);

  assert.equal((await post('/v1/chat/completions', {})).status, 400);
  assert.equal((await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' })).status, 400);
});

test('other websites and other hosts are refused', async () => {
  const { port, post, mock } = await setup({ alpha: {} });
  const body = { messages: [{ role: 'user', content: 'hi' }] };
  assert.equal((await post('/v1/chat/completions', body, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/keys', { vars: { ALPHA_KEY: 'stolen' } }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/v1/chat/completions', body, { origin: 'null' })).status, 403);
  assert.equal((await post('/v1/chat/completions', body, { origin: `http://127.0.0.1:${port}` })).status, 200);
  // A form post from another page cannot use JSON, and anything else is rejected.
  assert.equal((await post('/v1/chat/completions', body, { 'content-type': 'text/plain' })).status, 415);
  // DNS rebinding: the request reaches us but names some other host.
  assert.equal(await rawRequest(port, { headers: { host: 'evil.example' } }), 403);
  assert.equal(await rawRequest(port, { headers: { host: `localhost:${port}` } }), 200);
  assert.equal(mock.hits.alpha, 1);
});

test('keys can be saved through the API and bad names are refused', async () => {
  const { post, mock } = await setup({ alpha: { key: 'right' }, beta: {} });
  const wrong = await (await post('/api/keys', { vars: { ALPHA_KEY: 'wrong' } })).json();
  assert.equal(wrong.providers.find((p) => p.id === 'alpha').state, 'rejected');
  const right = await (await post('/api/keys', { vars: { ALPHA_KEY: 'right' } })).json();
  assert.equal(right.providers.find((p) => p.id === 'alpha').state, 'ready');
  assert.equal((await post('/api/keys', { vars: { PATH: '/tmp' } })).status, 400);
  assert.equal((await post('/api/keys', { vars: { ALPHA_KEY: 'has space' } })).status, 400);
  assert.ok(!JSON.stringify(right).includes('right'), 'status never echoes a key back');
  await mock.close();
});

test('a request asking for more output than a model allows is retried without the cap', async () => {
  const { post, mock } = await setup({ alpha: { maxTokens: 100 } });
  const res = await post('/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }], max_tokens: 32000 });
  assert.equal(res.status, 200);
  assert.deepEqual(mock.seen.map((s) => s.body.max_tokens), [32000, undefined]);
});

test('Anthropic-format requests are translated both ways', async () => {
  assert.equal(mapModel('claude-haiku-5-5'), 'auto:fast');
  assert.equal(mapModel('claude-fable-5-2'), 'auto');
  assert.equal(mapModel('groq/some-model'), 'groq/some-model');

  const oa = toOpenAI({
    model: 'claude-fable-5-2',
    system: [{ type: 'text', text: 'Be brief.' }],
    max_tokens: 500,
    stop_sequences: ['END'],
    tools: [{ name: 'get_weather', description: 'Weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }, { type: 'web_search_20250305', name: 'web_search' }],
    tool_choice: { type: 'any' },
    messages: [
      { role: 'user', content: 'Weather in Oslo?' },
      { role: 'assistant', content: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Oslo' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '4C' }] }, { type: 'text', text: 'And tomorrow?' }] },
    ],
  });
  assert.deepEqual(oa.messages.map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'user']);
  assert.equal(oa.messages[2].tool_calls[0].function.arguments, '{"city":"Oslo"}');
  assert.deepEqual(oa.messages[3], { role: 'tool', tool_call_id: 'toolu_1', content: '4C' });
  assert.equal(oa.messages[4].content, 'And tomorrow?');
  assert.equal(oa.tools.length, 1, 'server-side Anthropic tools are dropped');
  assert.equal(oa.tool_choice, 'required');
  assert.deepEqual(oa.stop, ['END']);

  const back = fromOpenAI({ choices: [{ message: { content: 'Hi', tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{"a":1}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 2 } }, 'm');
  assert.deepEqual(back.content, [{ type: 'text', text: 'Hi' }, { type: 'tool_use', id: 'c1', name: 'f', input: { a: 1 } }]);
  assert.equal(back.stop_reason, 'tool_use');
  assert.deepEqual(back.usage, { input_tokens: 3, output_tokens: 2 });
});

test('the Anthropic-format endpoint works end to end, including streaming and tool calls', async () => {
  const call = { tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } }] };
  const { post, mock } = await setup({ alpha: { models: ['big-70b', 'small-8b'], reply: (body) => (body.tools ? call : 'Hello from the router') } });
  const messages = [{ role: 'user', content: 'hi' }];

  const plain = await (await post('/v1/messages', { model: 'claude-haiku-5-5', max_tokens: 100, messages })).json();
  assert.equal(plain.type, 'message');
  assert.deepEqual(plain.content, [{ type: 'text', text: 'Hello from the router' }]);
  assert.equal(plain.stop_reason, 'end_turn');
  assert.equal(mock.seen[0].body.model, 'small-8b', 'haiku maps to the fast tier');

  const events = (raw) => raw.split('\n\n').filter(Boolean).map((b) => JSON.parse(b.split('\ndata: ')[1]));
  const streamed = events(await (await post('/v1/messages', { model: 'claude-fable-5-2', max_tokens: 100, stream: true, messages })).text());
  assert.deepEqual(streamed.map((e) => e.type).filter((t, i, a) => a[i - 1] !== t), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  assert.equal(streamed.filter((e) => e.type === 'content_block_delta').map((e) => e.delta.text).join(''), 'Hello from the router');
  assert.equal(streamed.find((e) => e.type === 'message_delta').delta.stop_reason, 'end_turn');

  const tools = [{ name: 'get_weather', input_schema: { type: 'object', properties: {} } }];
  const toolPlain = await (await post('/v1/messages', { model: 'claude-fable-5-2', max_tokens: 100, tools, messages })).json();
  assert.deepEqual(toolPlain.content, [{ type: 'tool_use', id: 'call_9', name: 'get_weather', input: { city: 'Oslo' } }]);
  assert.equal(toolPlain.stop_reason, 'tool_use');

  const toolStream = events(await (await post('/v1/messages', { model: 'claude-fable-5-2', max_tokens: 100, stream: true, tools, messages })).text());
  const start = toolStream.find((e) => e.type === 'content_block_start');
  assert.deepEqual(start.content_block, { type: 'tool_use', id: 'call_9', name: 'get_weather', input: {} });
  assert.equal(toolStream.filter((e) => e.delta?.type === 'input_json_delta').map((e) => e.delta.partial_json).join(''), '{"city":"Oslo"}');
  assert.equal(toolStream.find((e) => e.type === 'message_delta').delta.stop_reason, 'tool_use');

  assert.ok((await (await post('/v1/messages/count_tokens', { messages })).json()).input_tokens > 0);
  const bad = await post('/v1/messages', { model: 'x', messages: [] });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).type, 'error');
});

test('rate-limit errors reach Anthropic-format clients in their own shape', async () => {
  const { post } = await setup({ alpha: { limit: 0, retryAfter: 40 } });
  const res = await post('/v1/messages', { model: 'claude-fable-5-2', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error.type, 'rate_limit_error');
  assert.ok(Number(res.headers.get('retry-after')) > 0);
});

test('the MCP server answers the protocol and runs its tools through the local server', async () => {
  const { port } = await setup({ alpha: { reply: 'A thinks yes' }, beta: { reply: 'B thinks no' } }, { skillsDir: SKILLS });
  const rpc = (method, params, id = 1) => handleMessage({ jsonrpc: '2.0', id, method, params }, { port });

  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'ai-compiler');
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, { port }), null);
  assert.deepEqual((await rpc('ping')).result, {});
  assert.equal((await rpc('nope')).error.code, -32601);

  const tools = (await rpc('tools/list')).result.tools;
  assert.deepEqual(tools.map((t) => t.name), ['ask', 'panel', 'quota_status', 'list_skills', 'key_status', 'save_api_key', 'remove_api_key', 'generate_image']);
  for (const t of tools) assert.equal(t.inputSchema.type, 'object');

  const call = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result;
  const asked = await call('ask', { prompt: 'Is it so?' });
  assert.equal(asked.content[0].text, 'A thinks yes\n\n[via alpha/model-a]');
  const panel = await call('panel', { prompt: 'Is it so?', skill: 'critique' });
  assert.match(panel.content[0].text, /### Answer 1: Alpha · model-a\n\nA thinks yes[\s\S]*### Answer 2: Beta · model-a\n\nB thinks no[\s\S]*\[panel \+ critique: 2 free requests/);
  assert.match((await call('quota_status', {})).content[0].text, /2 of 2 providers ready[\s\S]*Alpha\s+ready/);
  assert.match((await call('list_skills', {})).content[0].text, /code-review: Review code/);
  const failed = await call('ask', { prompt: '' });
  assert.equal(failed.isError, true);
  assert.equal((await call('ask', { prompt: 'x', skill: 'no-such-skill' })).isError, true);
});

test('the command line talks to the running server', async () => {
  const { port } = await setup({ alpha: { reply: 'from the cli test' } });
  const run = (args) => new Promise((resolve) => execFile(process.execPath, [join(import.meta.dirname, '..', 'src', 'cli.js'), ...args, '--port', String(port)], { timeout: 20000 }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr })));
  const asked = await run(['ask', 'hello']);
  assert.equal(asked.code, 0, asked.stderr);
  assert.equal(asked.stdout, 'from the cli test\n');
  assert.match(asked.stderr, /via alpha\/model-a/);
  const status = await run(['status']);
  assert.match(status.stdout, /1 of 1 providers ready/);
  const json = await run(['ask', '--json', 'hello']);
  assert.equal(JSON.parse(json.stdout).aic.provider, 'alpha');
});

test('every shipped skill loads and has instructions', () => {
  const core = createCore({ memory: true, catalogData: { providers: [] }, skillsDir: SKILLS });
  const skills = core.skillList();
  assert.ok(skills.length >= 30, `only ${skills.length} skills loaded`);
  for (const s of skills) {
    assert.ok(s.description.length > 15, `${s.name} needs a description`);
    assert.ok(core.skills.get(s.name).prompt.length > 150, `${s.name} needs instructions`);
    assert.notEqual(s.category, 'other', `${s.name} needs a category`);
  }
  const tools = new Set(core.tools.describe().map((t) => t.name));
  for (const s of skills) for (const t of s.tools ?? []) assert.ok(tools.has(t), `${s.name} lists unknown tool ${t}`);
});

test('the command line attaches files, shows usage, and reports a missing file', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'aic-cli-'));
  writeFileSync(join(dir, 'notes.txt'), 'buy milk\n```\ncode inside\n```\n');
  const { port, mock } = await setup({ alpha: { reply: 'got it' } });
  const run = (args) => new Promise((resolve) => execFile(process.execPath, [join(import.meta.dirname, '..', 'src', 'cli.js'), ...args, '--port', String(port)], { timeout: 20000 }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr })));

  const asked = await run(['ask', '-f', join(dir, 'notes.txt'), 'What is in it?']);
  assert.equal(asked.code, 0, asked.stderr);
  const sent = mock.seen.at(-1).body.messages.at(-1).content;
  assert.match(sent, /^What is in it\?\n\nFile: notes\.txt\n````\nbuy milk\n```\ncode inside\n```\n````$/, 'a longer fence wraps a file that contains one');

  const usage = await run(['usage']);
  assert.equal(usage.code, 0, usage.stderr);
  assert.match(usage.stdout, /Day\s+Requests\s+Tokens/);
  assert.match(usage.stdout, /\d{4}-\d{2}-\d{2}\s+1\s+15\s+█+\s+Alpha \(1\)/);

  const missing = await run(['ask', '-f', join(dir, 'nope.txt'), 'hi']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /Cannot read .*nope\.txt/);
});
