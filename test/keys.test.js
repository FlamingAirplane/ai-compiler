// API keys are kept in one private file per user, shared by the server, the
// command line and the MCP server, and can be saved through MCP or the CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { keysFile, loadEnvFile, parseEnv, saveEnvVars } from '../src/config.js';
import { createCore } from '../src/gateway.js';
import { createServer, listen } from '../src/server.js';
import { handleMessage } from '../src/mcp.js';
import { startMock } from './mock-upstream.js';

const tmp = (name) => mkdtempSync(join(tmpdir(), `aic-${name}-`));

/** Run fn with some environment variables set, then put them back. */
async function withEnv(vars, fn) {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) if (v == null) delete process.env[k];
  else process.env[k] = v;
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(before)) if (v == null) delete process.env[k];
    else process.env[k] = v;
  }
}

test('keys live in a private per-user file, not in the project folder', () =>
  withEnv({ AIC_ENV_FILE: null, XDG_CONFIG_HOME: null }, () => {
    if (process.platform !== 'win32') assert.equal(keysFile(), join(homedir(), '.config', 'ai-compiler', 'keys.env'));
    return withEnv({ XDG_CONFIG_HOME: '/somewhere' }, () => {
      assert.equal(keysFile(), join('/somewhere', 'ai-compiler', 'keys.env'));
      return withEnv({ AIC_ENV_FILE: '/elsewhere/keys.env' }, () => assert.equal(keysFile(), '/elsewhere/keys.env'));
    });
  }));

test('saved keys are readable only by you, and the old project .env is still used', () => {
  const dir = tmp('keys');
  const file = join(dir, 'private', 'keys.env');
  const legacy = join(dir, 'project.env');
  writeFileSync(legacy, 'GROQ_API_KEY=old-groq\nGEMINI_API_KEY=old-gemini\n');
  return withEnv({ AIC_ENV_FILE: file, AIC_LEGACY_ENV_FILE: legacy }, () => {
    assert.deepEqual(loadEnvFile(keysFile()), { GROQ_API_KEY: 'old-groq', GEMINI_API_KEY: 'old-gemini' });

    saveEnvVars(keysFile(), { GROQ_API_KEY: 'new-groq' });
    assert.deepEqual(loadEnvFile(keysFile()), { GROQ_API_KEY: 'new-groq', GEMINI_API_KEY: 'old-gemini' }, 'the new file wins');
    if (process.platform !== 'win32') {
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(statSync(join(dir, 'private')).mode & 0o777, 0o700);
    }
    assert.match(readFileSync(file, 'utf8'), /^# AI Compiler API keys\. Keep this file private/);

    // Removing a key removes it everywhere, so it cannot come back from the old file.
    saveEnvVars(keysFile(), { GEMINI_API_KEY: '' });
    assert.deepEqual(loadEnvFile(keysFile()), { GROQ_API_KEY: 'new-groq' });
    assert.deepEqual(parseEnv(readFileSync(legacy, 'utf8')), { GROQ_API_KEY: 'old-groq' });
  });
});

test('MCP tools report, save, check and remove keys without ever showing them', async () => {
  const dir = tmp('mcp-keys');
  const file = join(dir, 'keys.env');
  const mock = await startMock({ alpha: { key: 'right-key' }, beta: {} });
  await withEnv({ AIC_ENV_FILE: file, AIC_LEGACY_ENV_FILE: join(dir, 'none.env'), ALPHA_KEY: null, BETA_KEY: null }, async () => {
    const core = createCore({ envFile: file, dataDir: join(dir, 'data'), catalogData: mock.catalog(), skillsDir: join(tmpdir(), 'aic-no-skills') });
    const server = createServer(core);
    const port = await listen(server, 0);
    server.unref();
    const call = async (name, args = {}) => (await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { port })).result;
    const text = (r) => r.content[0].text;

    const before = text(await call('key_status'));
    assert.match(before, new RegExp(`Keys are saved in ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(before, /ALPHA_KEY: not set\. Used by Alpha\./);
    assert.match(before, /aic keys set <NAME>/);

    const wrong = text(await call('save_api_key', { name: 'alpha_key', value: 'wrong-key' }));
    assert.match(wrong, /Saved ALPHA_KEY/);
    assert.match(wrong, /Alpha: the provider rejected this key/);

    const right = text(await call('save_api_key', { name: 'ALPHA_KEY', value: 'right-key' }));
    assert.match(right, /Alpha: ready, 1 model found\./);
    assert.equal(parseEnv(readFileSync(file, 'utf8')).ALPHA_KEY, 'right-key', 'written to the private file');

    const after = text(await call('key_status'));
    assert.match(after, /ALPHA_KEY: saved\./);
    assert.ok(!after.includes('right-key'), 'the key itself is never shown');

    // The saved key works straight away.
    const asked = text(await call('ask', { prompt: 'hello' }));
    assert.match(asked, /\[via alpha\/model-a\]/);

    const unknown = await call('save_api_key', { name: 'PATH', value: '/tmp' });
    assert.equal(unknown.isError, true);
    assert.match(text(unknown), /not a key AI Compiler uses/);

    assert.match(text(await call('remove_api_key', { name: 'ALPHA_KEY' })), /Removed ALPHA_KEY/);
    assert.equal(parseEnv(readFileSync(file, 'utf8')).ALPHA_KEY, undefined);
  });
  await mock.close();
});

test('aic keys set saves a key typed or piped in, without it on the command line', async () => {
  const dir = tmp('cli-keys');
  const file = join(dir, 'keys.env');
  const env = { ...process.env, AIC_ENV_FILE: file, AIC_LEGACY_ENV_FILE: join(dir, 'none.env'), AIC_DATA_DIR: join(dir, 'data'), AIC_PORT: '1' };
  const cli = (args, input) =>
    new Promise((resolve) => {
      const child = execFile(process.execPath, [join(import.meta.dirname, '..', 'src', 'cli.js'), ...args], { env, timeout: 30000 }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
      child.stdin.end(input ?? '');
    });
  const set = await cli(['keys', 'set', 'groq_api_key'], 'gsk-test-value\n');
  assert.equal(set.code, 0, set.stderr);
  assert.match(set.stdout, /Saved GROQ_API_KEY to .*keys\.env \(readable only by you\)/);
  assert.equal(parseEnv(readFileSync(file, 'utf8')).GROQ_API_KEY, 'gsk-test-value');

  const listed = await cli(['keys']);
  assert.match(listed.stdout, new RegExp(`Keys are saved in ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.ok(!listed.stdout.includes('gsk-test-value'));

  const removed = await cli(['keys', 'remove', 'GROQ_API_KEY']);
  assert.equal(removed.code, 0, removed.stderr);
  assert.equal(parseEnv(readFileSync(file, 'utf8')).GROQ_API_KEY, undefined);

  const bad = await cli(['keys', 'set', 'NOT_A_KEY'], 'x\n');
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /not a key this app uses/);
});
