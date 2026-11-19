// Helpers for OpenAI-style server-sent event streams.

const enc = new TextEncoder();

/** Parse one "data: {...}" line. Returns null for anything else, including [DONE]. */
export function parseSseLine(line) {
  if (!line.startsWith('data:')) return null;
  const d = line.slice(5).trim();
  if (!d || d === '[DONE]') return null;
  try {
    return JSON.parse(d);
  } catch {
    return null;
  }
}

export async function* lines(body) {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      yield buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
    }
  }
  if (buf) yield buf;
}

const NOTE = ': aic ';

/**
 * Yields each JSON event of a stream. Progress notes, which travel as SSE
 * comments so ordinary OpenAI clients ignore them, come out as { aic: {...} }.
 */
export async function* sseEvents(body) {
  for await (const line of lines(body)) {
    if (line.startsWith(NOTE)) {
      try {
        yield { aic: JSON.parse(line.slice(NOTE.length)) };
      } catch {
        /* ignore a malformed note */
      }
      continue;
    }
    const ev = parseSseLine(line);
    if (ev) yield ev;
  }
}

export const sseData = (obj) => enc.encode(`data: ${JSON.stringify(obj)}\n\n`);
export const sseDone = () => enc.encode('data: [DONE]\n\n');
export const sseNote = (obj) => enc.encode(`${NOTE}${JSON.stringify(obj)}\n\n`);

/** Message content (a string or an array of parts) as plain text. */
export function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
  return '';
}

export const estimateTokens = (value) => Math.ceil(JSON.stringify(value ?? '').length / 4);

/** Read a whole chat response (streamed or not) into { text, meta, error }. */
export async function collect(response) {
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('event-stream')) {
    const json = await response.json().catch(() => null);
    if (!response.ok || json?.error) return { text: '', meta: json?.aic ?? null, error: json?.error ?? { message: `HTTP ${response.status}` } };
    return { text: contentText(json?.choices?.[0]?.message?.content), meta: json?.aic ?? null, error: null };
  }
  let text = '';
  let meta = null;
  let error = null;
  for await (const ev of sseEvents(response.body)) {
    if (ev.aic) meta = { ...meta, ...ev.aic };
    else if (ev.error) error = ev.error;
    else text += contentText(ev.choices?.[0]?.delta?.content);
  }
  return { text, meta, error };
}
