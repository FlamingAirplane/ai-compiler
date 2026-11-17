// Translation between the Anthropic Messages API and the OpenAI chat format,
// so harnesses that speak Anthropic's format (Claude Code and others) can use
// this router as their model backend.

import { contentText, lines, parseSseLine } from './sse.js';

const enc = new TextEncoder();
const rand = () => Math.random().toString(36).slice(2, 12);
const STOP = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', function_call: 'tool_use', content_filter: 'refusal' };

function resultText(block) {
  const c = block.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : '')).join('\n') : '';
  return block.is_error ? `Error: ${text}` : text;
}

/** Which of our routes a Claude model name should use. Other names pass straight through. */
export function mapModel(model, map = {}) {
  const name = String(model ?? '');
  if (!/^claude/i.test(name)) return name || 'auto';
  return /haiku/i.test(name) ? map.small ?? 'auto:fast' : map.default ?? 'auto';
}

export function toOpenAI(body, modelMap) {
  const messages = [];
  const system = typeof body.system === 'string' ? body.system : Array.isArray(body.system) ? body.system.map((b) => b?.text ?? '').filter(Boolean).join('\n\n') : '';
  if (system) messages.push({ role: 'system', content: system });

  for (const m of body.messages ?? []) {
    if (typeof m.content === 'string') {
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    const blocks = Array.isArray(m.content) ? m.content : [];
    if (m.role === 'assistant') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const calls = blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      const out = { role: 'assistant', content: text || (calls.length ? null : '') };
      if (calls.length) out.tool_calls = calls;
      messages.push(out);
      continue;
    }
    // Tool results become their own "tool" messages and have to come before
    // any other text in the same turn.
    const parts = [];
    for (const b of blocks) {
      if (b.type === 'tool_result') messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: resultText(b) });
      else if (b.type === 'text') parts.push({ type: 'text', text: b.text });
      else if (b.type === 'image' && b.source) {
        const url = b.source.type === 'base64' ? `data:${b.source.media_type};base64,${b.source.data}` : b.source.url;
        if (url) parts.push({ type: 'image_url', image_url: { url } });
      }
    }
    if (parts.length) messages.push({ role: 'user', content: parts.every((p) => p.type === 'text') ? parts.map((p) => p.text).join('\n') : parts });
  }

  const out = { model: mapModel(body.model, modelMap), messages, stream: !!body.stream };
  if (body.max_tokens != null) out.max_tokens = body.max_tokens;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.stop_sequences?.length) out.stop = body.stop_sequences;

  // Only ordinary function tools translate; Anthropic's server-side tools have no equivalent here.
  const tools = (body.tools ?? [])
    .filter((t) => t?.name && t.input_schema)
    .map((t) => ({ type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.input_schema } }));
  if (tools.length) {
    out.tools = tools;
    const c = body.tool_choice;
    if (c?.type === 'any') out.tool_choice = 'required';
    else if (c?.type === 'tool' && c.name) out.tool_choice = { type: 'function', function: { name: c.name } };
    else if (c?.type === 'none') out.tool_choice = 'none';
    else if (c?.type === 'auto') out.tool_choice = 'auto';
  }
  return out;
}

export function fromOpenAI(data, model) {
  const choice = data?.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const content = [];
  const text = contentText(msg.content);
  if (text) content.push({ type: 'text', text });
  for (const c of msg.tool_calls ?? []) {
    let input = {};
    try {
      input = JSON.parse(c.function?.arguments || '{}');
    } catch {
      /* leave the input empty rather than fail the whole reply */
    }
    content.push({ type: 'tool_use', id: c.id ?? `toolu_${rand()}`, name: c.function?.name ?? '', input });
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  return {
    id: `msg_${rand()}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: msg.tool_calls?.length ? 'tool_use' : STOP[choice.finish_reason] ?? 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: data?.usage?.prompt_tokens ?? 0, output_tokens: data?.usage?.completion_tokens ?? 0 },
  };
}

/** Re-express an OpenAI-style event stream as Anthropic's message events. */
export function streamToAnthropic(body, model, inputTokens = 0) {
  const event = (name, data) => enc.encode(`event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`);
  let cancelled = false;
  return new ReadableStream({
    start(ctrl) {
      const push = (bytes) => {
        if (cancelled) return;
        try {
          ctrl.enqueue(bytes);
        } catch {
          cancelled = true;
        }
      };
      (async () => {
        push(event('message_start', { message: { id: `msg_${rand()}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 0 } } }));
        let index = -1;
        let open = null; // 'text', or the key of the tool call being written
        let openToolId = null;
        let sawTool = false;
        let finish = null;
        let usage = null;
        let failed = null;
        const close = () => {
          if (open === null) return;
          push(event('content_block_stop', { index }));
          open = null;
        };
        try {
          for await (const line of lines(body)) {
            if (cancelled) break;
            const ev = parseSseLine(line);
            if (!ev) continue;
            if (ev.error) {
              failed = ev.error;
              break;
            }
            if (ev.usage) usage = ev.usage;
            const choice = ev.choices?.[0];
            if (!choice) continue;
            const d = choice.delta ?? {};
            if (typeof d.content === 'string' && d.content) {
              if (open !== 'text') {
                close();
                index++;
                open = 'text';
                push(event('content_block_start', { index, content_block: { type: 'text', text: '' } }));
              }
              push(event('content_block_delta', { index, delta: { type: 'text_delta', text: d.content } }));
            }
            for (const t of d.tool_calls ?? []) {
              const key = `tool:${t.index ?? 0}`;
              // A new call starts when the index changes, or when a provider
              // reuses index 0 but sends a different call id.
              if (open !== key || (t.id && openToolId && t.id !== openToolId)) {
                close();
                index++;
                open = key;
                openToolId = t.id ?? `toolu_${rand()}`;
                sawTool = true;
                push(event('content_block_start', { index, content_block: { type: 'tool_use', id: openToolId, name: t.function?.name ?? '', input: {} } }));
              }
              const args = t.function?.arguments;
              if (args) push(event('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: args } }));
            }
            if (choice.finish_reason) finish = choice.finish_reason;
          }
        } catch (err) {
          failed = { message: String(err?.message ?? err) };
        }
        close();
        if (failed) {
          push(event('error', { error: { type: 'api_error', message: failed.message ?? 'The stream failed' } }));
        } else {
          push(event('message_delta', { delta: { stop_reason: sawTool ? 'tool_use' : STOP[finish] ?? 'end_turn', stop_sequence: null }, usage: { output_tokens: usage?.completion_tokens ?? 0 } }));
          push(event('message_stop', {}));
        }
        try {
          ctrl.close();
        } catch {
          /* already closed */
        }
      })();
    },
    cancel(reason) {
      cancelled = true;
      return body.cancel?.(reason);
    },
  });
}

const ERROR_TYPES = { 400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 404: 'not_found_error', 413: 'request_too_large', 429: 'rate_limit_error', 529: 'overloaded_error' };

export function anthropicError(status, message) {
  return { type: 'error', error: { type: ERROR_TYPES[status] ?? 'api_error', message } };
}
