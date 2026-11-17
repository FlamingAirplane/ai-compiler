#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { DEFAULT_PORT, VERSION } from './config.js';
import { getBackend } from './backend.js';
import { sseEvents, contentText } from './sse.js';
import { fmtNum, fmtWait, stateLabel, statusTable, table } from './format.js';

const HELP = `AI Compiler ${VERSION}
One endpoint for every free AI tier you have a key for.

Usage
  aic serve [--port ${DEFAULT_PORT}] [--open]     start the dashboard, chat and API
  aic ask "question" [options]           ask once (also reads piped input)
  aic chat [options]                     chat in the terminal
  aic status [--json]                    quota and rate limits per provider
  aic usage [--days 14]                  requests and tokens per day
  aic open                               open the dashboard in your browser
  aic check [provider]                   send one tiny request through each provider to prove it works
  aic keys                               which providers have keys, and where to get them
  aic models                             every model name you can use
  aic skills                             the skills you can apply
  aic mcp                                run as an MCP server (for Claude Code and other AI tools)

Options for ask and chat
  --mode <name>       auto (default), fast, smart, boost, ensemble, refine, agent, panel
  -s, --skill <name>  apply a skill, e.g. code-review, research, summarize ("auto" picks one)
  -m, --model <name>  exact route, e.g. groq or gemini/<model>
  --system <text>     system prompt
  -f, --file <path>   attach a text file (repeat for several)
  --copy              also copy the answer to the clipboard
  --json              print the raw JSON response
  --quiet             hide the progress lines

Agent tool permissions (serve, ask, chat, mcp; or set them in config.json)
  --workspace <dir>   let the agent read files in this folder
  --allow-write       let the agent write files in the workspace
  --allow-code        let the agent run code in the macOS sandbox

Examples
  aic ask "Explain DNS in two sentences"
  aic ask --mode boost "Compare SQLite and Postgres for a small web app"
  git diff | aic ask -s code-review "Review this diff"
  aic ask -f notes.txt -f todo.md -s summarize "What is left to do?"
  aic ask --mode agent -s research "What changed in the latest Node.js release?"
`;

const VALUE_FLAGS = new Set(['port', 'host', 'mode', 'skill', 'model', 'system', 'workspace', 'file', 'days']);
const LIST_FLAGS = new Set(['file']);
const ALIASES = { p: 'port', s: 'skill', m: 'model', h: 'help', v: 'version', q: 'quiet', f: 'file' };

function parseArgs(argv) {
  const flags = {};
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      words.push(...argv.slice(i + 1));
      break;
    }
    const m = a.match(/^--([a-z][a-z-]*)(?:=(.*))?$/) ?? a.match(/^-([a-z])$/);
    if (!m) {
      words.push(a);
      continue;
    }
    const name = ALIASES[m[1]] ?? m[1];
    if (LIST_FLAGS.has(name)) (flags[name] ??= []).push(m[2] ?? argv[++i]);
    else if (VALUE_FLAGS.has(name)) flags[name] = m[2] ?? argv[++i];
    else flags[name] = true;
  }
  return { flags, words };
}

const dim = (s) => (process.stderr.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const die = (message) => {
  console.error(message);
  process.exit(1);
};

/** Flags that grant the agent extra tools, as a config override. */
function coreOptions(flags) {
  const agent = {};
  if (flags.workspace) agent.workspace = flags.workspace;
  if (flags['allow-write']) agent.allowWrite = true;
  if (flags['allow-code']) agent.allowCode = true;
  return Object.keys(agent).length ? { configData: { harness: { agent } } } : {};
}

const backendFor = (flags) => getBackend({ port: Number(flags.port) || DEFAULT_PORT, coreOptions: coreOptions(flags) });

const MODE_MODEL = { auto: 'auto', fast: 'auto:fast', smart: 'auto:smart' };

function requestBody(flags, messages, stream) {
  const body = { model: flags.model ?? MODE_MODEL[flags.mode] ?? 'auto', messages, stream };
  const aic = { source: 'cli' };
  if (flags.mode && !MODE_MODEL[flags.mode]) aic.mode = flags.mode;
  if (flags.skill) aic.skill = flags.skill;
  body.aic = aic;
  return body;
}

function describeNote(n) {
  switch (n.event) {
    case 'route':
      return `via ${n.provider}/${n.model}${n.attempts?.length > 1 ? ` (after ${n.attempts.length - 1} fallback${n.attempts.length > 2 ? 's' : ''})` : ''}`;
    case 'plan':
      return n.models ? `${n.mode}: asking ${n.models.join(', ')}` : n.tools ? `agent tools: ${n.tools.join(', ')}` : `${n.mode}: starting`;
    case 'stage':
      return `  ${n.ok ? 'ok' : 'failed'}  ${n.role}${n.ok ? `  ${n.provider}/${n.model}  ${(n.ms / 1000).toFixed(1)}s` : `  ${n.error ?? ''}`}`;
    case 'tool':
      return `  tool ${n.name} ${n.args}`;
    case 'info':
      return n.message;
    case 'done':
      return `${n.requests} free request${n.requests === 1 ? '' : 's'} used`;
    default:
      return null;
  }
}

/** Print a streamed reply as it arrives. Returns the full text, or null if it failed. */
async function printStream(res, { quiet }) {
  if (!(res.headers.get('content-type') ?? '').includes('event-stream')) {
    const data = await res.json().catch(() => null);
    if (!res.ok || data?.error) {
      const e = data?.error ?? { message: `HTTP ${res.status}` };
      console.error(`Error: ${e.message}${e.retry_at ? ` Free quota is back in about ${fmtWait(Date.parse(e.retry_at) - Date.now())}.` : ''}`);
      return null;
    }
    const text = contentText(data?.choices?.[0]?.message?.content);
    process.stdout.write(`${text}\n`);
    return text;
  }
  let text = '';
  let failed = false;
  for await (const ev of sseEvents(res.body)) {
    if (ev.aic) {
      const line = quiet ? null : describeNote(ev.aic);
      if (line) console.error(dim(line));
    } else if (ev.error) {
      console.error(`Error: ${ev.error.message}`);
      failed = true;
    } else {
      const piece = contentText(ev.choices?.[0]?.delta?.content);
      text += piece;
      process.stdout.write(piece);
    }
  }
  if (text && !text.endsWith('\n')) process.stdout.write('\n');
  return failed ? null : text;
}

function readStdin(firstChunkWithinMs) {
  return new Promise((resolve) => {
    let data = '';
    let timer = null;
    const finish = () => {
      clearTimeout(timer);
      process.stdin.pause();
      resolve(data);
    };
    // With a prompt on the command line, piped input is optional: do not wait
    // forever on a stdin that is open but silent.
    if (firstChunkWithinMs) timer = setTimeout(finish, firstChunkWithinMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      clearTimeout(timer);
      data += c;
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

/** Read files given with -f as fenced blocks the model can tell apart. */
function readAttachments(paths = []) {
  return paths.map((path) => {
    let size;
    try {
      size = statSync(path).size;
    } catch {
      die(`Cannot read ${path}: no such file.`);
    }
    if (size > 1_000_000) die(`${path} is too large to attach (over 1 MB).`);
    const text = readFileSync(path, 'utf8');
    if (text.includes('\0')) die(`${path} looks like a binary file. Only text files can be attached.`);
    let fence = '```';
    while (text.includes(fence)) fence += '`';
    return `File: ${basename(path)}\n${fence}\n${text.replace(/\n$/, '')}\n${fence}`;
  });
}

/** Copy text with whatever clipboard tool this system has. */
function copyToClipboard(text) {
  const tools = process.platform === 'darwin' ? [['pbcopy']] : process.platform === 'win32' ? [['clip']] : [['wl-copy'], ['xclip', '-selection', 'clipboard'], ['xsel', '--clipboard', '--input']];
  for (const [cmd, ...args] of tools) {
    const r = spawnSync(cmd, args, { input: text });
    if (!r.error && r.status === 0) return true;
  }
  return false;
}

async function ask(flags, words) {
  let prompt = words.join(' ').trim();
  if (!process.stdin.isTTY) {
    const piped = (await readStdin(prompt || flags.file ? 200 : 0)).trim();
    if (piped) prompt = prompt ? `${prompt}\n\n${piped}` : piped;
  }
  const files = readAttachments(flags.file);
  if (!prompt && files.length) prompt = 'Please look at the attached files.';
  if (!prompt) die('Give it something to answer, for example:  aic ask "What is a closure?"');
  if (files.length) prompt = [prompt, ...files].join('\n\n');
  const backend = await backendFor(flags);
  const messages = [...(flags.system ? [{ role: 'system', content: flags.system }] : []), { role: 'user', content: prompt }];
  const res = await backend.chat(requestBody(flags, messages, !flags.json));
  let ok = true;
  if (flags.json) {
    const raw = await res.text();
    process.stdout.write(raw.endsWith('\n') ? raw : `${raw}\n`);
    ok = res.ok;
  } else {
    const text = await printStream(res, flags);
    ok = text !== null;
    if (ok && flags.copy) console.error(dim(copyToClipboard(text) ? 'Copied to the clipboard.' : 'Could not find a clipboard tool to copy with.'));
  }
  backend.close();
  process.exit(ok ? 0 : 1);
}

async function usage(flags) {
  const days = Math.min(Math.max(Number(flags.days) || 14, 1), 35);
  const backend = await backendFor(flags);
  const { providers } = await backend.status();
  backend.close();
  const byDay = new Map();
  const add = (day, p, req, tok) => {
    const d = byDay.get(day) ?? { requests: 0, tokens: 0, by: {} };
    d.requests += req;
    d.tokens += tok;
    if (req) d.by[p.name] = (d.by[p.name] ?? 0) + req;
    byDay.set(day, d);
  };
  for (const p of providers) {
    for (const [day, h] of Object.entries(p.history ?? {})) add(day, p, h.requests, h.tokens);
    if (p.day) add(p.day, p, p.today.requests, p.today.tokens);
  }
  const list = [...byDay.keys()].sort().slice(-days);
  if (!list.some((d) => byDay.get(d).requests)) return console.log('No requests yet.');
  const max = Math.max(...list.map((d) => byDay.get(d).requests));
  const rows = [['Day', 'Requests', 'Tokens', '', 'Busiest provider']];
  for (const day of list) {
    const d = byDay.get(day);
    const top = Object.entries(d.by).sort((a, b) => b[1] - a[1])[0];
    rows.push([day, String(d.requests), fmtNum(d.tokens), '█'.repeat(Math.round((d.requests / max) * 20)) || '·', top ? `${top[0]} (${top[1]})` : '-']);
  }
  console.log(table(rows));
  const totals = providers.filter((p) => p.total.requests).sort((a, b) => b.total.requests - a.total.requests);
  if (totals.length) console.log(`\nAll time: ${totals.map((p) => `${p.name} ${p.total.requests}`).join(', ')}`);
}

async function open(flags) {
  const port = Number(flags.port) || DEFAULT_PORT;
  const url = `http://localhost:${port}`;
  const up = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(800) }).then((r) => r.ok, () => false);
  if (!up) die('AI Compiler is not running. Start it with "aic serve --open".');
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
  console.log(`Opened ${url}`);
}

async function chat(flags) {
  const backend = await backendFor(flags);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let messages = flags.system ? [{ role: 'system', content: flags.system }] : [];
  console.log(dim(`AI Compiler chat (${backend.kind === 'server' ? `through the server at ${backend.where}` : 'no server running, using this process'}).`));
  console.log(dim('Commands: /new  /mode <name>  /skill <name|off>  /model <name>  /status  /quit'));
  rl.on('close', () => {
    backend.close();
    process.exit(0);
  });
  for (;;) {
    const line = (await rl.question('\n> ')).trim();
    if (!line) continue;
    if (line.startsWith('/')) {
      const [cmd, ...rest] = line.slice(1).split(/\s+/);
      const arg = rest.join(' ');
      if (cmd === 'quit' || cmd === 'exit') rl.close();
      else if (cmd === 'new') messages = messages.filter((m) => m.role === 'system');
      else if (cmd === 'mode') flags.mode = arg || undefined;
      else if (cmd === 'model') flags.model = arg || undefined;
      else if (cmd === 'skill') flags.skill = arg && arg !== 'off' ? arg : undefined;
      else if (cmd === 'status') console.log(statusTable(await backend.status()));
      else console.log('Unknown command.');
      continue;
    }
    messages.push({ role: 'user', content: line });
    const text = await printStream(await backend.chat(requestBody(flags, messages, true)), flags);
    if (text === null) messages.pop();
    else messages.push({ role: 'assistant', content: text });
  }
}

async function serve(flags) {
  const [{ createCore }, { createServer, listen }] = await Promise.all([import('./gateway.js'), import('./server.js')]);
  const core = createCore(coreOptions(flags));
  const host = flags.host ?? '127.0.0.1';
  const extra = (process.env.AIC_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean);
  const server = createServer(core, { allowedHosts: extra });
  let port;
  try {
    port = await listen(server, flags.port != null ? Number(flags.port) : DEFAULT_PORT, host);
  } catch (err) {
    if (err.code === 'EADDRINUSE') die(`Port ${flags.port ?? DEFAULT_PORT} is already in use. AI Compiler may already be running; otherwise pick another port with --port.`);
    throw err;
  }
  const url = `http://localhost:${port}`;
  await core.ready().catch(() => {});
  const { totals, providers } = core.status();
  console.log(`AI Compiler is running

  Chat and dashboard     ${url}
  OpenAI-compatible API  ${url}/v1
  Anthropic-format API   ${url}

  ${totals.configured ? `${totals.ready} of ${providers.length} providers ready.` : 'No API keys yet. Open the dashboard to add a free one.'}
  Press Ctrl+C to stop.`);
  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.log(`\n  Warning: listening on ${host}. Anyone who can reach this address can spend your free quota.`);
  }
  if (flags.open) spawn(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
  const stop = () => {
    core.close();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function check(flags, words) {
  const backend = await backendFor(flags);
  const which = words[0];
  console.error(dim(`Sending one tiny request through ${which ?? 'each provider that has a key'}…`));
  let results;
  try {
    results = await backend.test(which);
  } catch (err) {
    die(`Error: ${err.message}`);
  }
  if (!results.length) die('No providers have keys yet. Run "aic keys" to see where to get them.');
  const rows = [['Provider', 'Result', 'Model', 'Time', 'Details']];
  for (const r of results) {
    rows.push([r.name ?? r.provider, r.ok ? 'works' : 'failed', r.model ?? '-', r.ms != null ? `${(r.ms / 1000).toFixed(1)}s` : '-', r.ok ? `replied "${r.reply}"${r.fallbacks ? ` after ${r.fallbacks} fallback${r.fallbacks > 1 ? 's' : ''}` : ''}` : r.message]);
  }
  console.log(table(rows));
  backend.close();
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

async function keys(flags) {
  const backend = await backendFor(flags);
  const { providers, toolKeys } = await backend.status();
  const rows = [['Provider', 'State', 'Key name', 'Get a free key']];
  for (const p of providers) rows.push([p.name, stateLabel(p.state), p.env.join(' + ') || '(none needed)', p.signupUrl ?? '']);
  for (const k of toolKeys) rows.push(['Web search (Tavily)', k.set ? 'set' : 'no key', k.name, 'https://app.tavily.com']);
  console.log(table(rows));
  console.log('\nAdd keys in the dashboard (aic serve), or as NAME=value lines in the .env file next to package.json.');
  console.log('Use one key per provider, from your own account.');
  backend.close();
}

async function main() {
  const [command = 'help', ...rest] = process.argv.slice(2);
  const { flags, words } = parseArgs(rest);
  if (flags.help || command === 'help' || command === '--help' || command === '-h') return console.log(HELP);
  if (command === 'version' || command === '--version' || command === '-v') return console.log(VERSION);
  switch (command) {
    case 'serve':
      return serve(flags);
    case 'ask':
      return ask(flags, words);
    case 'chat':
      return chat(flags);
    case 'keys':
      return keys(flags);
    case 'check':
      return check(flags, words);
    case 'usage':
      return usage(flags);
    case 'open':
      return open(flags);
    case 'status': {
      const backend = await backendFor(flags);
      const status = await backend.status();
      console.log(flags.json ? JSON.stringify(status, null, 2) : statusTable(status));
      return backend.close();
    }
    case 'models': {
      const backend = await backendFor(flags);
      const { data } = await backend.models();
      console.log(table([['Name', 'What it is'], ...data.map((m) => [m.id, m.description ?? ''])]));
      return backend.close();
    }
    case 'skills': {
      const backend = await backendFor(flags);
      const skills = await backend.skills();
      if (!skills.length) console.log('No skills are installed. Add Markdown files to the skills folder.');
      const byCategory = Map.groupBy(skills, (s) => s.category);
      for (const [category, list] of [...byCategory].sort(([a], [b]) => a.localeCompare(b))) {
        console.log(`\n${category.toUpperCase()}`);
        console.log(table(list.map((s) => [`  ${s.name}`, s.mode === 'single' ? '' : `[${s.mode}]`, s.description])));
      }
      return backend.close();
    }
    case 'mcp': {
      const { runMcp } = await import('./mcp.js');
      return runMcp({ port: Number(flags.port) || DEFAULT_PORT, coreOptions: coreOptions(flags) });
    }
    default:
      die(`Unknown command "${command}". Run "aic help" to see what is available.`);
  }
}

main().catch((err) => die(`Error: ${err?.message ?? err}`));
