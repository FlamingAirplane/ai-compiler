// A Model Context Protocol server over stdio, so AI tools such as Claude Code
// can call the free-model router directly: ask one question, get a panel of
// independent answers, check the remaining quota, or list skills.
//
// stdout carries only protocol messages. Anything for a human goes to stderr.

import { createInterface } from 'node:readline';
import { APP, VERSION } from './config.js';
import { getBackend } from './backend.js';
import { collect } from './sse.js';
import { statusTable } from './format.js';

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
