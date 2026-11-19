// A Model Context Protocol server over stdio, so AI tools such as Claude Code
// can call the free-model router directly: ask one question, get a panel of
// independent answers, check the remaining quota, or list skills.
//
// stdout carries only protocol messages. Anything for a human goes to stderr.

import { createInterface } from 'node:readline';
import { APP, VERSION } from './config.js';
import { getBackend } from './backend.js';
import { collect } from './sse.js';
import { statusTable, stateLabel } from './format.js';
import { keysFile } from './config.js';

const MODES = ['auto', 'fast', 'smart', 'boost', 'ensemble', 'refine', 'agent'];
const MODEL_FOR = { auto: 'auto', fast: 'auto:fast', smart: 'auto:smart' };

const TOOLS = [
  {
    name: 'ask',
    description:
      'Ask the free-tier AI models a question and get one answer. Use it for a second opinion, a cheap first draft, or a self-contained subtask. ' +
      'mode "auto" sends one request to the best free model available; "boost" spends several requests for a better answer (several models answer, one compiles); ' +
      '"refine" is draft, critique, revise; "agent" lets the model use web and calculator tools. A skill adds task-specific instructions (see list_skills). ' +
      'The prompt goes to third-party free AI services, some of which keep prompts for training, so do not include secrets or private data.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The full question or task. The models see nothing else, so include all the context they need.' },
        mode: { type: 'string', enum: MODES, description: 'How much effort to spend. Default "auto".' },
        skill: { type: 'string', description: 'Optional skill name from list_skills, for example "code-review" or "research".' },
        system: { type: 'string', description: 'Optional system prompt.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'panel',
    description:
      'Ask several different free AI models the same question in parallel and get all of their answers back side by side, uncompiled. ' +
      'Best when you want to judge the answers yourself: independent reviews of a design or diff, checking whether models agree on a fact, or collecting varied ideas. ' +
      'Costs one free request per model. The prompt goes to third-party free AI services, so do not include secrets or private data.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The full question or task, with all the context the models need.' },
        skill: { type: 'string', description: 'Optional skill name from list_skills.' },
        system: { type: 'string', description: 'Optional system prompt.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'quota_status',
    description: 'Show which free AI providers are set up, how much each has been used today, which are rate limited and when they reset.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_skills',
    description: 'List the skills (task-specific instruction presets) that ask and panel accept.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'key_status',
    description:
      'Show which free AI providers have an API key saved on this computer, which still need one, where to get each free key, and the file the keys are saved in. Never shows the keys themselves.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'save_api_key',
    description:
      'Save a free-tier API key on this computer so AI Compiler (the MCP server, the dashboard and the command line) can use it from now on. ' +
      'The key is written to a private file only the user can read, checked against its provider, and sent only to that provider. ' +
      'Only call this with a key the user gave you for this purpose. The key passes through this conversation, so when the user would rather keep it out of the chat, ' +
      'suggest they run "aic keys set <NAME>" in a terminal instead, which asks for it without showing it. Use key_status to find the right NAME.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The key name, for example GROQ_API_KEY or GEMINI_API_KEY (see key_status).' },
        value: { type: 'string', description: 'The API key.' },
      },
      required: ['name', 'value'],
    },
  },
  {
    name: 'remove_api_key',
    description: 'Delete a saved API key from this computer.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'The key name, for example GROQ_API_KEY.' } }, required: ['name'] },
  },
  {
    name: 'generate_image',
    description:
      'Generate an image from a text prompt on free image tiers (Cloudflare, NVIDIA, Hugging Face, or the keyless Pollinations service). ' +
      'Returns the image and the path it was saved to. Can take up to a minute or two on free tiers. The prompt goes to third-party services, so do not include private data.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to draw: subject, style, composition.' },
        size: { type: 'string', description: 'WIDTHxHEIGHT, for example 1024x1024 (default), 768x1024 or 1024x768.' },
        enhance: { type: 'boolean', description: 'Let a free chat model expand the prompt first. Costs one free chat request.' },
      },
      required: ['prompt'],
    },
  },
];

function footer(meta) {
  if (!meta) return '';
  if (meta.stages) {
    const used = [...new Set(meta.stages.filter((s) => s.ok).map((s) => `${s.provider}/${s.model}`))];
    return `\n\n[${meta.mode}${meta.skill ? ` + ${meta.skill}` : ''}: ${meta.requests} free request${meta.requests === 1 ? '' : 's'} via ${used.join(', ')}]`;
  }
  return meta.provider ? `\n\n[via ${meta.provider}/${meta.model}${meta.skill ? `, skill ${meta.skill}` : ''}]` : '';
}

async function chat(backend, args, mode) {
  const prompt = String(args?.prompt ?? '').trim();
  if (!prompt) throw new Error('"prompt" is required.');
  const messages = [];
  if (args.system) messages.push({ role: 'system', content: String(args.system) });
  messages.push({ role: 'user', content: prompt });
  const body = { messages, model: MODEL_FOR[mode] ?? mode, stream: false, aic: { source: 'mcp' } };
  if (args.skill) body.aic.skill = String(args.skill);
  const { text, meta, error } = await collect(await backend.chat(body));
  if (error) {
    const when = error.retry_at ? ` Try again after ${error.retry_at}.` : '';
    throw new Error(`${error.message}${when}`);
  }
  return text + footer(meta);
}

async function callTool(name, args, opts) {
  const backend = await getBackend(opts);
  switch (name) {
    case 'ask': {
      const mode = MODES.includes(args?.mode) ? args.mode : 'auto';
      return chat(backend, args, mode);
    }
    case 'panel':
      return chat(backend, args, 'panel');
    case 'quota_status':
      return statusTable(await backend.status());
    case 'list_skills': {
      const skills = await backend.skills();
      if (!skills.length) return 'No skills are installed.';
      return skills.map((s) => `${s.name}${s.mode !== 'single' ? ` (${s.mode})` : ''}: ${s.description}`).join('\n');
    }
    case 'key_status':
      return keyReport(await backend.status());
    case 'save_api_key':
    case 'remove_api_key': {
      const status = await backend.status();
      const keyName = String(args?.name ?? '').trim().toUpperCase();
      const known = knownKeys(status);
      if (!known.has(keyName)) throw new Error(`"${keyName || '(none)'}" is not a key AI Compiler uses. Known keys: ${[...known.keys()].join(', ')}.`);
      const value = name === 'save_api_key' ? String(args?.value ?? '').trim() : '';
      if (name === 'save_api_key' && !value) throw new Error('"value" is required.');
      const after = await backend.setKeys({ [keyName]: value });
      if (name === 'remove_api_key') return `Removed ${keyName} from ${keysFile()}.`;
      const lines = [`Saved ${keyName} to ${keysFile()} (readable only by you).`];
      for (const p of after.providers.filter((x) => x.env.includes(keyName))) {
        const detail = p.state === 'ready' ? `ready, ${p.models.length} model${p.models.length === 1 ? '' : 's'} found` : p.state === 'no_key' ? `still needs ${p.missing.join(', ')}` : p.state === 'rejected' ? 'the provider rejected this key; check it was copied in full' : stateLabel(p.state);
        lines.push(`${p.name}: ${detail}.`);
      }
      for (const p of (after.images?.providers ?? []).filter((x) => x.env.includes(keyName))) lines.push(`${p.name} images: ${stateLabel(p.state)}.`);
      if (keyName === 'TAVILY_API_KEY') lines.push('Web search for the agent is on.');
      return lines.join('\n');
    }
    case 'generate_image': {
      const prompt = String(args?.prompt ?? '').trim();
      if (!prompt) throw new Error('"prompt" is required.');
      const out = await backend.image({ prompt, size: args.size, aic: { source: 'mcp', enhance: !!args.enhance } });
      const img = out.images[0];
      const where = img.file ? `Saved as data/images/${img.file} in the AI Compiler folder${backend.kind === 'server' ? `, and at ${backend.where}/images/${img.file}` : ''}.` : '';
      return [
        { type: 'image', data: img.b64, mimeType: img.mime },
        { type: 'text', text: [`Made with ${img.providerName ?? img.provider} (${img.model}), ${img.width}x${img.height}. ${where}`, out.revisedPrompt ? `Prompt used: ${out.revisedPrompt}` : ''].filter(Boolean).join('\n') },
      ];
    }
    default:
      throw new Error(`Unknown tool "${name}".`);
  }
}

/** Every key name AI Compiler uses, with the services each one turns on. */
function knownKeys(status) {
  const map = new Map();
  const add = (name, what) => map.set(name, [...(map.get(name) ?? []), what]);
  for (const p of status.providers) for (const n of p.env) add(n, p.name);
  for (const p of status.images?.providers ?? []) for (const n of p.env) add(n, `${p.name} images`);
  for (const k of status.toolKeys ?? []) add(k.name, 'web search');
  return map;
}

function keyReport(status) {
  const set = (name) => status.providers.some((p) => p.env.includes(name) && !p.missing.includes(name)) || (status.toolKeys ?? []).some((k) => k.name === name && k.set);
  const lines = [`Keys are saved in ${keysFile()}, a private file on this computer.`, ''];
  for (const [name, uses] of knownKeys(status)) {
    const p = status.providers.find((x) => x.env.includes(name));
    const link = p?.signupUrl ?? (name === 'TAVILY_API_KEY' ? 'https://app.tavily.com' : '');
    const state = set(name) ? (p?.state === 'rejected' ? 'saved, but rejected by the provider' : 'saved') : 'not set';
    lines.push(`${name}: ${state}. Used by ${[...new Set(uses)].join(', ')}.${set(name) || !link ? '' : ` Get one free at ${link}`}`);
  }
  lines.push('', 'To add a key without it appearing in a chat, run: aic keys set <NAME>');
  return lines.join('\n');
}

export async function handleMessage(msg, opts = {}) {
  const { id, method, params } = msg ?? {};
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const error = (code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  if (typeof method !== 'string') return error(-32600, 'Invalid request');
  const isNotification = id === undefined;
  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: APP, version: VERSION },
        instructions:
          'Routes prompts to free-tier AI models (Gemini, Groq, OpenRouter and others) using the user\'s own free API keys. ' +
          'Use "panel" for independent second opinions you will judge yourself, and "ask" for one answer. ' +
          'Prompts leave this machine for third-party services: never include secrets, credentials or personal data.',
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call':
      try {
        const out = await callTool(params?.name, params?.arguments ?? {}, opts);
        return reply({ content: typeof out === 'string' ? [{ type: 'text', text: out }] : out });
      } catch (err) {
        return reply({ content: [{ type: 'text', text: `Error: ${err?.message ?? err}` }], isError: true });
      }
    default:
      return isNotification ? null : error(-32601, `Method not found: ${method}`);
  }
}

export function runMcp(opts = {}) {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
  let pending = 0;
  let closed = false;
  const maybeExit = () => {
    if (closed && pending === 0) process.exit(0);
  };
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    pending++;
    try {
      const out = await handleMessage(msg, opts);
      if (out && msg.id !== undefined) send(out);
    } finally {
      pending--;
      maybeExit();
    }
  });
  rl.on('close', () => {
    closed = true;
    maybeExit();
  });
}
