// Dashboard and chat for AI Compiler. No framework, no build step.

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) node.append(kid);
  return node;
}

const store = {
  get(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage is a convenience only */
    }
  },
};

// ------------------------------------------------------------- formatting

const fmtNum = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}k` : String(n));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function fmtWait(ms) {
  if (ms <= 0) return 'a moment';
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.ceil(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const STATES = { ready: 'Ready', cooling: 'Rate limited', no_key: 'No key', rejected: 'Key rejected', checking: 'Checking…', no_models: 'No models', offline: 'Not running', unreachable: 'Unreachable' };
const BUCKETS = ['requests/day', 'requests', 'requests/hour', 'requests/minute', 'tokens/day', 'tokens', 'tokens/minute'];

function reported(p) {
  const [scope, latest] = Object.entries(p.limits || {}).sort(([, a], [, b]) => b.at - a.at)[0] ?? [];
  if (!latest) return null;
  for (const key of BUCKETS) {
    const b = latest.buckets[key];
    if (b && b.remaining != null && b.limit) {
      const [kind, window] = key.split('/');
      // Name the model when the count is for one model and the provider has others.
      const model = scope !== '*' && p.models.length > 1 ? scope : null;
      return { remaining: b.remaining, limit: b.limit, kind, window, resetAt: b.resetAt ?? null, model };
    }
  }
  return null;
}

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Inline Markdown on text that is already HTML-escaped. */
function inline(s) {
  return s
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*\n]*)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

const isRow = (line) => /^\s*\|.*\|\s*$/.test(line);
const isDivider = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(esc(c.trim())));

/**
 * A small Markdown renderer: headings, lists, tables, code, emphasis, links.
 * Everything from the model is escaped before any tag is added, so model
 * output can never inject markup.
 */
function markdown(src) {
  const out = [];
  src.split(/^```/m).forEach((part, i) => {
    if (i % 2 === 1) {
      const nl = part.indexOf('\n');
      out.push(`<pre><code>${esc(nl === -1 ? '' : part.slice(nl + 1).replace(/\n$/, ''))}</code></pre>`);
      return;
    }
    let list = null;
    let para = [];
    const flushPara = () => {
      if (para.length) out.push(`<p>${para.join('<br>')}</p>`);
      para = [];
    };
    const flushList = () => {
      if (list) out.push(`</${list}>`);
      list = null;
    };
    const rows = part.split('\n');
    for (let r = 0; r < rows.length; r++) {
      const raw = rows[r];
      if (isRow(raw) && r + 1 < rows.length && isDivider(rows[r + 1])) {
        flushPara();
        flushList();
        const head = cells(raw);
        const body = [];
        r += 2;
        while (r < rows.length && isRow(rows[r])) body.push(cells(rows[r++]));
        r--;
        out.push(
          `<div class="table"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${body
            .map((row) => `<tr>${row.map((c) => `<td>${c}</td>`).join('')}</tr>`)
            .join('')}</tbody></table></div>`,
        );
        continue;
      }
      const line = esc(raw);
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
      const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (heading) {
        flushPara();
        flushList();
        const tag = heading[1].length <= 2 ? 'h3' : 'h4';
        out.push(`<${tag}>${inline(heading[2])}</${tag}>`);
      } else if (bullet || numbered) {
        flushPara();
        const want = bullet ? 'ul' : 'ol';
        if (list !== want) {
          flushList();
          out.push(`<${want}>`);
          list = want;
        }
        out.push(`<li>${inline((bullet || numbered)[1])}</li>`);
      } else if (/^\s*(-{3,}|\*{3,})\s*$/.test(raw)) {
        flushPara();
        flushList();
        out.push('<hr>');
      } else if (!raw.trim()) {
        flushPara();
        flushList();
      } else {
        flushList();
        para.push(inline(line));
      }
    }
    flushPara();
    flushList();
  });
  return out.join('');
}

async function copy(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const was = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => (button.textContent = was), 1200);
  } catch {
    button.textContent = 'Copy failed';
  }
}

// ------------------------------------------------------------------ state

let status = null;
let skew = 0; // this clock minus the server clock
let skills = [];
// Saved chats, newest first. Older versions kept one chat under 'aic.chat'.
const newChat = (messages = []) => ({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, title: '', system: '', messages, updated: Date.now() });
let chats = store.get('aic.chats', null);
if (!Array.isArray(chats) || !chats.length) chats = [newChat(store.get('aic.chat', []))];
let chat = chats.find((c) => c.id === store.get('aic.current', null)) ?? chats[0];
let messages = chat.messages;
let attachments = []; // [{ name, text }] waiting to go with the next message
let running = null; // AbortController while a reply is streaming
const cards = new Map();
const serverNow = () => Date.now() - skew;
const providerName = (id) => status?.providers.find((p) => p.id === id)?.name ?? id;

// The browser version answers API calls inside the page; the local server version uses the network.
const serverFetch = (...args) => (window.AIC_FETCH ?? fetch)(...args);

async function api(path, body) {
  const res = await serverFetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message ?? `Request failed (${res.status})`);
  return data;
}

// -------------------------------------------------------------- providers

function keyForm(names, { link, linkText, onSaved }) {
  const inputs = names.map((name) => el('input', { type: 'password', name, placeholder: name, 'aria-label': name, autocomplete: 'off', spellcheck: 'false' }));
  const result = el('span', { class: 'result', role: 'status' });
  const save = el('button', { class: 'primary', type: 'submit', text: 'Save key' });
  const remove = el('button', { class: 'ghost', type: 'button', text: 'Remove key', hidden: true });
  const submit = async (vars, busyText) => {
    save.disabled = remove.disabled = true;
    result.textContent = busyText;
    try {
      setStatus(await api('/api/keys', { vars }));
      inputs.forEach((i) => (i.value = ''));
      result.textContent = onSaved(vars);
    } catch (err) {
      result.textContent = err.message;
    }
    save.disabled = remove.disabled = false;
  };
  const form = el(
    'form',
    {
      class: 'keyform',
      onsubmit: (e) => {
        e.preventDefault();
        const vars = Object.fromEntries(inputs.filter((i) => i.value.trim()).map((i) => [i.name, i.value.trim()]));
        if (Object.keys(vars).length) submit(vars, 'Checking the key…');
      },
    },
    inputs,
    el('div', { class: 'actions' }, save, remove, link && el('a', { href: link, target: '_blank', rel: 'noopener noreferrer', text: linkText })),
    result,
  );
  remove.addEventListener('click', () => submit(Object.fromEntries(names.map((n) => [n, ''])), 'Removing…'));
  return { form, remove, result };
}

function buildCard(p) {
  const c = {};
  c.dot = el('span', { class: 'dot' });
  c.pill = el('span', { class: 'pill' });
  c.usage = el('div', { class: 'usage' });
  c.fill = el('span');
  c.meter = el('div', { class: 'meter', hidden: true }, c.fill);
  c.left = el('div', { class: 'left' });
  c.chips = el('div', { class: 'chips' });
  c.problem = el('p', { class: 'problem' });
  c.testResult = el('span', { class: 'result', role: 'status' });
  c.test = el('button', {
    class: 'ghost',
    type: 'button',
    text: 'Test',
    title: 'Send one tiny request through this provider (uses one free request)',
    onclick: async () => {
      c.test.disabled = true;
      c.testResult.textContent = 'Sending a test request…';
      try {
        const { results, status: next } = await api('/api/test', { provider: p.id });
        const r = results[0];
        c.testResult.textContent = r.ok ? `Works: ${r.model} answered in ${(r.ms / 1000).toFixed(1)}s.` : `Failed: ${r.message}`;
        setStatus(next);
      } catch (err) {
        c.testResult.textContent = err.message;
      }
      c.test.disabled = false;
    },
  });
  c.testRow = el('div', { class: 'actions test' }, c.test, c.testResult);
  const inner = el('div', { class: 'inner' }, el('p', { class: 'note', text: p.freeTier }), c.chips, c.problem, c.testRow);
  if (p.env.length) {
    const k = keyForm(p.env, {
      link: p.signupUrl,
      linkText: 'Get a free key ↗',
      onSaved: (vars) => {
        const now = status.providers.find((x) => x.id === p.id);
        if (Object.values(vars).every((v) => !v)) return 'Key removed.';
        if (now.state === 'rejected') return 'The provider rejected that key.';
        if (now.state === 'no_key') return `Still needs: ${now.missing.join(', ')}`;
        return now.models.length ? `Key works. ${plural(now.models.length, 'model')} found. Press Test to try one.` : now.problem ?? 'Saved.';
      },
    });
    c.remove = k.remove;
    inner.append(k.form);
  } else if (p.signupUrl) {
    inner.append(el('a', { href: p.signupUrl, target: '_blank', rel: 'noopener noreferrer', text: 'How to install ↗' }));
  }
  c.root = el('details', { class: 'card' }, el('summary', {}, el('div', { class: 'row' }, c.dot, el('span', { class: 'pname', text: p.name }), c.pill), c.usage, c.meter, c.left), inner);
  return c;
}

function updateCard(c, p) {
  const now = serverNow();
  c.dot.className = `dot ${p.state}`;
  c.pill.className = `pill ${p.state}`;
  c.pill.textContent = p.state === 'cooling' ? `Back in ${fmtWait(p.availableAt - now)}` : STATES[p.state] ?? p.state;
  const set = p.state !== 'no_key';
  c.usage.textContent = p.today.requests ? `${plural(p.today.requests, 'request')} · ${fmtNum(p.today.tokens)} tokens today` : set ? 'Not used yet today' : 'Add a key to use this free tier';

  const r = reported(p);
  let left = '';
  c.meter.hidden = true;
  if (set && r) {
    c.meter.hidden = false;
    c.meter.className = 'meter';
    c.fill.style.width = `${Math.max(0, Math.min(100, (r.remaining / r.limit) * 100))}%`;
    const refill = r.resetAt && r.resetAt > now ? `, refills in ${fmtWait(r.resetAt - now)}` : '';
    left = `${r.model ? `${r.model}: ` : ''}${fmtNum(r.remaining)} of ${fmtNum(r.limit)} ${r.kind} left${r.window ? ` this ${r.window}` : ''}${refill} (reported by the provider)`;
  } else if (set && p.hint?.rpd) {
    const remaining = Math.max(0, p.hint.rpd - p.today.requests);
    c.meter.hidden = false;
    c.meter.className = 'meter est';
    c.fill.style.width = `${(remaining / p.hint.rpd) * 100}%`;
    left = `About ${remaining} of ${p.hint.rpd} requests left today (estimate)`;
  } else if (p.local && p.state === 'ready') {
    left = 'Unlimited, runs on this computer';
  }
  if (p.state === 'cooling' && p.coolingReason) left = `${p.coolingReason[0].toUpperCase()}${p.coolingReason.slice(1)}. ${left}`.trim();
  else if (p.state === 'ready' && !p.local) left = `${left ? `${left}. ` : ''}Day resets in ${fmtWait(p.resetAt - now)}`;
  c.left.textContent = left;
  c.left.hidden = !left;

  c.chips.replaceChildren(
    ...p.models.map((m) =>
      el('span', {
        class: `chip${m.coolingUntil ? ' cool' : ''}`,
        text: m.id,
        title: m.coolingUntil ? `${m.coolingReason}, back in ${fmtWait(m.coolingUntil - now)}` : `${m.tier} model${m.tools === false ? ', no tool calling' : ''}${m.today ? `, ${plural(m.today.requests, 'request')} today` : ''}`,
      }),
    ),
  );
  const recent = p.lastError && now - p.lastError.at < 3600e3 ? `Last problem (${fmtTime(p.lastError.at)}): ${p.lastError.message}` : '';
  c.problem.textContent = p.state === 'rejected' ? 'The provider rejected this key. Paste a new one below.' : p.problem ?? recent;
  c.problem.hidden = !c.problem.textContent;
  c.testRow.hidden = !set || p.state === 'rejected';
  if (c.remove) c.remove.hidden = !set;
}

function renderProviders() {
  const holder = $('providers');
  const ordered = [...status.providers].sort((a, b) => (a.state === 'no_key') - (b.state === 'no_key'));
  ordered.forEach((p, i) => {
    let c = cards.get(p.id);
    if (!c) {
      c = buildCard(p);
      cards.set(p.id, c);
    }
    updateCard(c, p);
    if (holder.children[i] !== c.root) holder.insertBefore(c.root, holder.children[i] ?? null);
  });
}

let toolsSignature = '';
function renderTools() {
  const signature = JSON.stringify([status.tools, status.toolKeys]);
  if (signature === toolsSignature) return;
  toolsSignature = signature;
  const searchKeySet = status.toolKeys.some((k) => k.name === 'TAVILY_API_KEY' && k.set);
  $('tools').replaceChildren(
    ...status.tools.map((t) => {
      const row = el('div', { class: 'tool' }, el('span', {}, el('b', { text: t.name }), ` ${t.summary}`), el('span', { class: `state${t.available ? '' : ' off'}`, text: t.available ? 'On' : 'Off' }));
      if (!t.available) row.append(el('span', { class: 'why', text: `To turn on: ${t.reason}.` }));
      if (t.name === 'web_search') {
        const k = keyForm(['TAVILY_API_KEY'], { link: 'https://app.tavily.com', linkText: 'Free Tavily key ↗', onSaved: (vars) => (vars.TAVILY_API_KEY ? 'Saved. Web search is on.' : 'Key removed.') });
        k.remove.hidden = !searchKeySet;
        row.append(el('details', { class: 'why' }, el('summary', { text: searchKeySet ? 'Change the search key' : 'Add a search key' }), k.form));
      }
      return row;
    }),
  );
}

const SOURCES = { chat: 'Chat', api: 'API', anthropic: 'Anthropic API', mcp: 'MCP', cli: 'CLI', check: 'Test' };

let activitySignature = '';
function renderActivity() {
  const list = status.activity ?? [];
  const signature = JSON.stringify(list.map((a) => a.at));
  if (signature === activitySignature) return;
  activitySignature = signature;
  const holder = $('activity');
  if (!list.length) {
    holder.replaceChildren(el('p', { class: 'muted', text: 'Requests appear here as they come in, from the chat, the API, the command line or AI tools.' }));
    return;
  }
  holder.replaceChildren(
    ...list.slice(0, 12).map((a) => {
      const where = a.provider ? `${providerName(a.provider)}${a.model ? ` · ${a.model}` : ''}` : '';
      const what = [a.mode !== 'single' && a.mode !== 'check' ? a.mode : null, a.skill].filter(Boolean).join(' + ');
      const extra = a.ok
        ? [a.requests > 1 ? plural(a.requests, 'request') : null, a.fallbacks ? `${plural(a.fallbacks, 'fallback')}` : null, a.ms != null ? `${(a.ms / 1000).toFixed(1)}s` : null].filter(Boolean).join(' · ')
        : a.error;
      return el(
        'div',
        { class: `act${a.ok ? '' : ' bad'}`, title: a.error ?? '' },
        el('span', { class: 'when', text: fmtTime(a.at) }),
        el('span', { class: 'src', text: SOURCES[a.source] ?? a.source }),
        el('span', { class: 'what' }, what ? el('b', { text: `${what} ` }) : null, where || (a.ok ? '' : 'failed')),
        el('span', { class: 'extra', text: extra ?? '' }),
      );
    }),
  );
}

let modelSignature = '';
function renderModelOptions() {
  const groups = status.providers.filter((p) => p.models.length);
  const signature = JSON.stringify(groups.map((p) => [p.id, p.models.map((m) => m.id)]));
  if (signature === modelSignature) return;
  modelSignature = signature;
  const select = $('model');
  const current = select.value || store.get('aic.model', 'auto');
  select.replaceChildren(
    el('option', { value: 'auto', text: 'Auto' }),
    el('option', { value: 'auto:smart', text: 'Auto · larger models' }),
    el('option', { value: 'auto:fast', text: 'Auto · faster models' }),
    ...groups.map((p) => el('optgroup', { label: p.name }, el('option', { value: p.id, text: `Any ${p.name} model` }), p.models.map((m) => el('option', { value: `${p.id}/${m.id}`, text: m.id })))),
  );
  select.value = [...select.options].some((o) => o.value === current) ? current : 'auto';
}

function renderSummary() {
  const t = status.totals;
  $('summary').textContent = t.configured
    ? `${t.ready} of ${t.configured} set-up providers ready · ${fmtNum(t.requests)} requests and ${fmtNum(t.tokens)} tokens used today`
    : 'No providers set up yet';
}

function renderHint() {
  const mode = $('mode').value;
  const skill = skills.find((s) => s.name === $('skill').value);
  const parts = [];
  if (mode === 'boost') parts.push(`Boost runs ${skill?.boost ?? status?.harness.boost ?? 'ensemble'}: ${status?.harness.modes[skill?.boost ?? status?.harness.boost] ?? ''}`);
  else if (mode) parts.push(status?.harness.modes[mode] ?? '');
  else if (skill?.mode && skill.mode !== 'single') parts.push(`This skill runs as ${skill.mode}: ${status?.harness.modes[skill.mode] ?? ''}`);
  if (skill) parts.push(`Skill: ${skill.description}`);
  $('hint').textContent = parts.join(' ');
}

function renderUsage() {
  const byDay = new Map();
  const add = (day, req, tok) => {
    const d = byDay.get(day) ?? { requests: 0, tokens: 0 };
    d.requests += req;
    d.tokens += tok;
    byDay.set(day, d);
  };
  for (const p of status.providers) {
    for (const [day, h] of Object.entries(p.history ?? {})) add(day, h.requests, h.tokens);
    if (p.day) add(p.day, p.today.requests, p.today.tokens);
  }
  const days = [];
  for (let i = 13; i >= 0; i--) days.push(new Date(serverNow() - i * 864e5).toISOString().slice(0, 10));
  const values = days.map((d) => byDay.get(d) ?? { requests: 0, tokens: 0 });
  const max = Math.max(1, ...values.map((v) => v.requests));
  const total = values.reduce((n, v) => n + v.requests, 0);
  $('usage').replaceChildren(
    el('div', { class: 'bars', role: 'img', 'aria-label': `${total} requests in the last 14 days` }, values.map((v, i) =>
      el('span', { class: `${v.requests ? '' : 'zero'}${i === 13 ? ' today' : ''}`, style: `height:${Math.max(3, (v.requests / max) * 100)}%`, title: `${days[i]}: ${plural(v.requests, 'request')}, ${fmtNum(v.tokens)} tokens` }),
    )),
    el('div', { class: 'totals' }, el('span', { text: `${plural(total, 'request')} · ${fmtNum(values.reduce((n, v) => n + v.tokens, 0))} tokens` }), el('span', { text: 'today on the right' })),
  );
}

function setStatus(next) {
  const first = !status; // saved messages were drawn before provider names were known
  if (status) {
    for (const p of next.providers) {
      const before = status.providers.find((x) => x.id === p.id);
      if (before?.state === 'cooling' && p.state === 'ready') toast(`${p.name} is available again.`);
      if (before && before.state !== 'rejected' && p.state === 'rejected') toast(`${p.name} rejected its API key.`);
    }
  }
  status = next;
  skew = Date.now() - next.now;
  renderSummary();
  renderProviders();
  renderTools();
  renderActivity();
  renderUsage();
  renderModelOptions();
  renderImageOptions();
  renderHint();
  if (first || !messages.length) renderMessages();
}

async function poll() {
  try {
    setStatus(await api('/api/status'));
  } catch {
    $('summary').textContent = 'Cannot reach the local server. Is "aic serve" still running?';
  }
}

// ------------------------------------------------------------------- chat

const STARTERS = [
  { text: 'Explain how DNS works in plain language', mode: '' },
  { text: 'Compare SQLite and Postgres for a small web app', mode: 'boost' },
  { text: 'What is 17.5% of 2,480, and how did you work it out?', mode: 'agent' },
];

function emptyState() {
  if (!status) return el('div', { class: 'empty' }, el('p', { text: 'Loading…' }));
  if (!status.totals.ready) {
    const waiting = status.providers.filter((p) => p.state === 'cooling');
    if (waiting.length) {
      const soonest = Math.min(...waiting.map((p) => p.availableAt));
      return el('div', { class: 'empty' }, el('h2', { text: 'Every free tier is resting' }), el('p', { text: `All the providers you set up are rate limited right now. The first one is back in ${fmtWait(soonest - serverNow())}. Adding a key for another provider gives you more room.` }));
    }
    const picks = status.providers.filter((p) => p.state === 'no_key' && p.env.length).slice(0, 3);
    return el(
      'div',
      { class: 'empty' },
      el('h2', { text: 'Add a free API key to start' }),
      el('p', { text: 'AI Compiler sends your prompts to whichever free AI tier still has quota. It needs at least one key, and each extra provider adds more free quota.' }),
      el('ol', {}, el('li', { text: 'Open a provider on the right and follow “Get a free key”.' }), el('li', { text: 'Create a key on the provider’s site (no card needed for these).' }), el('li', { text: 'Paste it into the provider’s card and press Save.' })),
      el('p', {}, 'Good ones to start with: ', picks.flatMap((p, i) => [i ? ', ' : '', el('a', { href: p.signupUrl, target: '_blank', rel: 'noopener noreferrer', text: p.name })]), '.'),
    );
  }
  return el(
    'div',
    { class: 'empty' },
    el('h2', { text: 'What do you want to work on?' }),
    el('p', { text: 'Standard uses one free request. Boost spends a few to have several models answer and one compile the result.' }),
    el('div', { class: 'starters' }, STARTERS.map((s) => el('button', { type: 'button', text: s.text, onclick: () => { $('mode').value = s.mode; renderHint(); send(s.text); } }))),
  );
}

function describeNote(n) {
  if (n.event === 'plan') return n.models ? { text: `${n.mode}: asking ${plural(n.models.length, 'model')}` } : n.tools ? { text: `agent tools: ${n.tools.join(', ')}` } : null;
  if (n.event === 'stage') return { cls: n.ok ? 'ok' : 'no', text: n.ok ? `${n.role} · ${providerName(n.provider)} · ${n.model} · ${(n.ms / 1000).toFixed(1)}s` : `${n.role} failed: ${n.error ?? ''}` };
  if (n.event === 'tool') return { cls: 'call', text: `${n.name} ${n.args}` };
  if (n.event === 'info') return { text: n.message };
  return null;
}

function metaText(m) {
  const meta = m.meta;
  if (!meta) return m.stopped ? 'Stopped' : '';
  if (meta.stages) {
    const used = [...new Set(meta.stages.filter((s) => s.ok).map((s) => providerName(s.provider)))];
    return `${meta.mode}${meta.skill ? ` + ${meta.skill}` : ''} · ${plural(meta.requests, 'free request')} · ${used.join(', ')}`;
  }
  const falls = (meta.attempts?.length ?? 1) - 1;
  return `${providerName(meta.provider)} · ${meta.model}${meta.skill ? ` · skill ${meta.skill}` : ''}${falls > 0 ? ` · after ${plural(falls, 'fallback')}` : ''}${m.stopped ? ' · stopped' : ''}`;
}

function retry(index) {
  if (running) return;
  const question = messages[index - 1];
  if (!question || question.role !== 'user') return;
  messages.splice(index - 1, 2);
  attachments = question.files ?? [];
  send(question.content);
}

/** Put a sent message back in the box to change it, dropping it and everything after it. */
function editMessage(index) {
  if (running) return;
  const m = messages[index];
  messages.splice(index);
  attachments = m.files ?? [];
  renderAttachments();
  saveChats();
  renderMessages();
  const input = $('input');
  input.value = m.content;
  input.dispatchEvent(new Event('input'));
  input.focus();
}

function messageNode(m, index) {
  if (m.role === 'user') {
    const bubble = el('div', { class: 'msg user', text: m.content || '(files only)' });
    if (m.files?.length) bubble.append(el('div', { class: 'files' }, m.files.map((f) => el('span', { class: 'file-chip', title: `${f.text.length.toLocaleString()} characters` }, el('span', { text: `📎 ${f.name}` })))));
    return el('div', { class: 'user-wrap' }, bubble, el('span', { class: 'acts' }, el('button', { type: 'button', class: 'link', text: 'Edit', onclick: () => editMessage(index) })));
  }
  const node = el('div', { class: 'msg assistant' });
  const steps = (m.notes ?? []).map(describeNote).filter(Boolean);
  if (steps.length) node.append(el('ul', { class: 'steps' }, steps.map((s) => el('li', { class: s.cls, text: s.text, title: s.text }))));
  const body = el('div', { class: `body${m.pending ? ' typing' : ''}` });
  body.innerHTML = markdown(m.content || ''); // markdown() escapes everything it is given
  for (const pre of body.querySelectorAll('pre')) {
    const button = el('button', { type: 'button', class: 'copy', text: 'Copy', 'aria-label': 'Copy code' });
    button.addEventListener('click', () => copy(pre.textContent, button));
    pre.append(button);
  }
  node.append(body);
  if (m.error) node.append(el('p', { class: 'err', text: m.error }));
  const meta = metaText(m);
  const actions = [];
  if (!m.pending && m.content) {
    const b = el('button', { type: 'button', class: 'link', text: 'Copy' });
    b.addEventListener('click', () => copy(m.content, b));
    actions.push(b);
  }
  if (!m.pending && (m.error || m.stopped)) actions.push(el('button', { type: 'button', class: 'link', text: 'Retry', onclick: () => retry(index) }));
  else if (!m.pending && index === messages.length - 1) actions.push(el('button', { type: 'button', class: 'link', text: 'Regenerate', title: 'Ask again for a different answer', onclick: () => retry(index) }));
  if (meta || actions.length) node.append(el('div', { class: 'meta' }, meta, actions.length ? el('span', { class: 'acts' }, actions) : null));
  return node;
}

function renderMessages() {
  const box = $('messages');
  const pinned = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.replaceChildren(...(messages.length ? messages.map(messageNode) : [emptyState()]));
  if (pinned) box.scrollTop = box.scrollHeight;
}

let frame = 0;
const scheduleRender = () => {
  if (!frame) frame = requestAnimationFrame(() => { frame = 0; renderMessages(); });
};

function errorText(e) {
  if (!e) return 'Something went wrong.';
  const wait = e.retry_at ? ` Free quota is back in about ${fmtWait(Date.parse(e.retry_at) - Date.now())}.` : '';
  return `${e.message}${wait}`;
}

async function readStream(body, reply) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line.startsWith(': aic ')) {
        const note = JSON.parse(line.slice(6));
        if (note.event === 'route' || note.event === 'done') reply.meta = note;
        else reply.notes.push(note);
      } else if (line.startsWith('data:') && line !== 'data: [DONE]') {
        let ev;
        try {
          ev = JSON.parse(line.slice(5));
        } catch {
          continue;
        }
        if (ev.error) reply.error = errorText(ev.error);
        const piece = ev.choices?.[0]?.delta?.content;
        if (typeof piece === 'string') reply.content += piece;
      }
      scheduleRender();
    }
  }
}

/** What a message says to the model: its text, plus any attached files. */
function apiContent(m) {
  if (!m.files?.length) return m.content;
  const parts = m.files.map((f) => {
    let fence = '```';
    while (f.text.includes(fence)) fence += '`';
    return `File: ${f.name}\n${fence}\n${f.text}\n${fence}`;
  });
  return [m.content, ...parts].filter(Boolean).join('\n\n');
}

async function send(text) {
  if (running || (!text.trim() && !attachments.length)) return;
  const history = messages.filter((m) => (m.content || m.files?.length) && !m.error).map((m) => ({ role: m.role, content: apiContent(m) }));
  const question = { role: 'user', content: text.trim() };
  if (attachments.length) question.files = attachments;
  attachments = [];
  renderAttachments();
  messages.push(question);
  const reply = { role: 'assistant', content: '', notes: [], meta: null, pending: true };
  messages.push(reply);
  renderMessages();
  $('messages').scrollTop = $('messages').scrollHeight;

  const system = chat.system?.trim() ? [{ role: 'system', content: chat.system.trim() }] : [];
  const body = { model: $('model').value || 'auto', messages: [...system, ...history, { role: 'user', content: apiContent(question) }], stream: true, aic: { source: 'chat' } };
  saveChats();
  if ($('mode').value) body.aic.mode = $('mode').value;
  if ($('skill').value) body.aic.skill = $('skill').value;

  running = new AbortController();
  $('send').textContent = 'Stop';
  $('send').classList.add('stop');
  try {
    const res = await serverFetch('/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: running.signal });
    if ((res.headers.get('content-type') ?? '').includes('event-stream')) {
      await readStream(res.body, reply);
    } else {
      const data = await res.json();
      if (data.error) reply.error = errorText(data.error);
      else {
        reply.content = data.choices?.[0]?.message?.content ?? '';
        reply.meta = data.aic ?? null;
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') reply.stopped = true;
    else reply.error = 'Lost the connection to the local server.';
  }
  reply.pending = false;
  running = null;
  $('send').textContent = 'Send';
  $('send').classList.remove('stop');
  saveChats();
  renderMessages();
  poll();
}

// ------------------------------------------------------------------ chats

function saveChats() {
  chat.messages = messages = messages.slice(-60);
  chat.updated = Date.now();
  const first = messages.find((m) => m.role === 'user');
  if (!chat.title && first) chat.title = (first.content || first.files?.[0]?.name || 'Files').replace(/\s+/g, ' ').slice(0, 60);
  chats.sort((a, b) => b.updated - a.updated);
  // Keep the 40 most recent chats so local storage stays small.
  if (chats.length > 40) chats = chats.filter((c, i) => i < 40 || c === chat);
  store.set('aic.chats', chats);
  store.set('aic.current', chat.id);
  renderChatList();
}

function chatLabel(c) {
  if (c.title) return c.title;
  const first = c.messages.find((m) => m.role === 'user');
  return first ? (first.content || first.files?.[0]?.name || 'Files').replace(/\s+/g, ' ').slice(0, 60) : 'New chat';
}

function renderChatList() {
  const select = $('chat');
  select.replaceChildren(...chats.map((c) => el('option', { value: c.id, text: chatLabel(c), selected: c === chat })));
  $('delete').disabled = chats.length === 1 && !messages.length;
  $('system').value = chat.system ?? '';
  if (chat.system?.trim()) $('instructions').dataset.set = '';
  else delete $('instructions').dataset.set;
}

function switchChat(target) {
  if (running) running.abort();
  chat = target;
  messages = chat.messages;
  attachments = [];
  renderAttachments();
  store.set('aic.current', chat.id);
  renderChatList();
  renderMessages();
}

function startNewChat() {
  // An empty chat is reused rather than piling up empty ones.
  const empty = chats.find((c) => !c.messages.length);
  if (empty) {
    switchChat(empty);
  } else {
    const c = newChat();
    chats.unshift(c);
    switchChat(c);
  }
  $('input').focus();
}

function exportChat() {
  const lines = [`# ${chatLabel(chat)}`, '', `Exported from AI Compiler on ${new Date().toLocaleString()}.`, ''];
  if (chat.system?.trim()) lines.push('**Instructions:** ' + chat.system.trim(), '');
  for (const m of messages) {
    if (m.role === 'user') {
      lines.push('## You', '', m.content || '');
      if (m.files?.length) lines.push('', `Attached: ${m.files.map((f) => f.name).join(', ')}`);
    } else {
      const meta = metaText(m);
      lines.push(`## Assistant${meta ? ` (${meta})` : ''}`, '', m.content || (m.error ? `Error: ${m.error}` : ''));
    }
    lines.push('');
  }
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/markdown' }));
  const name = `${(chat.title || 'chat').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'chat'}.md`;
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ------------------------------------------------------------ attachments

const MAX_FILE = 200_000;

async function addFiles(list) {
  for (const file of list) {
    if (file.size > MAX_FILE) {
      toast(`${file.name} is too large to attach (over ${MAX_FILE / 1000} KB).`);
      continue;
    }
    const text = await file.text();
    if (text.includes('\0')) {
      toast(`${file.name} looks like a binary file. Only text files can be attached.`);
      continue;
    }
    attachments = [...attachments.filter((f) => f.name !== file.name), { name: file.name, text }];
  }
  renderAttachments();
  $('input').focus();
}

function renderAttachments() {
  const box = $('attachments');
  box.hidden = !attachments.length;
  box.replaceChildren(
    ...attachments.map((f) =>
      el(
        'span',
        { class: 'file-chip', title: `${f.text.length.toLocaleString()} characters` },
        el('span', { text: `📎 ${f.name}` }),
        el('button', { type: 'button', 'aria-label': `Remove ${f.name}`, text: '×', onclick: () => { attachments = attachments.filter((x) => x !== f); renderAttachments(); } }),
      ),
    ),
  );
}

// ------------------------------------------------------------------ images

let gallery = [];
let imaging = null; // { controller, cards } while images are being made

function setView(view) {
  const images = view === 'images';
  $('imagesView').hidden = !images;
  $('chatView').hidden = images;
  $('tabImages').setAttribute('aria-selected', String(images));
  $('tabChat').setAttribute('aria-selected', String(!images));
  store.set('aic.view', view);
  (images ? $('imgPrompt') : $('input')).focus();
  if (images) loadGallery();
}

async function loadGallery() {
  try {
    gallery = (await api('/api/images')).images;
  } catch {
    gallery = [];
  }
  renderGallery();
}

function shotCard(img) {
  const url = img.src ?? `/images/${encodeURIComponent(img.file)}`;
  const del = el('button', { type: 'button', class: 'link', text: 'Delete' });
  del.addEventListener('click', async () => {
    if (!confirm('Delete this image? This cannot be undone.')) return;
    gallery = (await api('/api/images/delete', { file: img.file })).images;
    renderGallery();
  });
  const copyBtn = el('button', { type: 'button', class: 'link', text: 'Copy prompt' });
  copyBtn.addEventListener('click', () => copy(img.revisedPrompt || img.prompt, copyBtn));
  return el(
    'figure',
    { class: 'shot' },
    el('a', { class: 'pic', href: url, target: '_blank', rel: 'noopener', title: 'Open full size' }, el('img', { src: url, alt: img.prompt, loading: 'lazy', width: img.width, height: img.height })),
    el(
      'figcaption',
      {},
      el('span', { class: 'p', text: img.prompt, title: img.revisedPrompt ? `Prompt used: ${img.revisedPrompt}` : img.prompt }),
      el('span', { class: 'm', text: `${img.providerName ?? img.provider} · ${img.width}×${img.height} · ${fmtTime(img.at)}` }),
      el(
        'span',
        { class: 'acts' },
        el('a', { class: 'link', href: url, download: img.file, text: 'Download' }),
        el('button', { type: 'button', class: 'link', text: 'Reuse', title: 'Put this prompt back in the box', onclick: () => { $('imgPrompt').value = img.prompt; $('imgPrompt').focus(); } }),
        copyBtn,
        del,
      ),
    ),
  );
}

function renderGallery() {
  const pending = imaging?.cards ?? [];
  const cards = gallery.map(shotCard);
  $('gallery').replaceChildren(...pending, ...(cards.length || pending.length ? cards : [el('p', { class: 'empty-note', text: window.AIC_BROWSER ? 'Images you make appear here, saved in this browser.' : 'Images you make appear here, saved on this computer in data/images.' })]));
}

let imgSignature = '';
function renderImageOptions() {
  const list = status?.images?.providers ?? [];
  const signature = JSON.stringify(list.map((p) => [p.id, p.state, p.models.map((m) => m.id)]));
  if (signature === imgSignature) return;
  imgSignature = signature;
  const select = $('imgModel');
  const current = select.value || store.get('aic.imgModel', 'auto');
  const usable = list.filter((p) => p.state !== 'no_key');
  select.replaceChildren(
    el('option', { value: 'auto', text: 'Auto' }),
    ...usable.map((p) => el('optgroup', { label: p.name }, el('option', { value: p.id, text: `Any ${p.name} model` }), p.models.length > 1 ? p.models.map((m) => el('option', { value: `${p.id}/${m.id}`, text: m.id.split('/').pop() })) : [])),
  );
  select.value = [...select.options].some((o) => o.value === current) ? current : 'auto';
  const ready = list.filter((p) => p.state === 'ready').map((p) => p.name);
  const resting = list.filter((p) => p.state === 'cooling').map((p) => `${p.name} (back in ${fmtWait(p.availableAt - serverNow())})`);
  const missing = list.filter((p) => p.state === 'no_key').map((p) => p.name);
  $('imgHint').textContent = [
    ready.length ? `Ready: ${ready.join(', ')}.` : 'No image provider is ready right now.',
    resting.length ? `Resting: ${resting.join(', ')}.` : '',
    missing.length ? `Add a key on the right for more free images from ${missing.join(', ')}.` : '',
    'Free tiers can take a minute or two.',
  ].filter(Boolean).join(' ');
}

async function generate() {
  if (imaging) {
    imaging.controller.abort();
    return;
  }
  const prompt = $('imgPrompt').value.trim();
  if (!prompt) return $('imgPrompt').focus();
  const n = Number($('imgCount').value);
  const started = Date.now();
  const label = () => `Making ${n > 1 ? `${n} images` : 'the image'}… ${Math.round((Date.now() - started) / 1000)}s`;
  const cards = Array.from({ length: n }, () => el('figure', { class: 'shot pending' }, el('div', { class: 'pic', text: label() }), el('figcaption', {}, el('span', { class: 'p', text: prompt }))));
  imaging = { controller: new AbortController(), cards };
  const tick = setInterval(() => cards.forEach((c) => (c.firstChild.textContent = label())), 1000);
  $('imgGo').textContent = 'Stop';
  renderGallery();
  try {
    const res = await serverFetch('/v1/images/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, n, size: $('imgSize').value, model: $('imgModel').value, response_format: 'url', aic: { source: 'chat', enhance: $('imgEnhance').checked } }),
      signal: imaging.controller.signal,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(errorText(data.error));
    if (data.aic?.partial) toast(data.aic.partial);
    if (data.aic?.revisedPrompt) toast('Prompt improved. Hover an image to see the prompt that was used.');
    imaging = null;
    await loadGallery();
  } catch (err) {
    const failed = el('figure', { class: 'shot failed' }, el('div', { class: 'pic', text: err.name === 'AbortError' ? 'Stopped.' : err.message }), el('figcaption', {}, el('span', { class: 'p', text: prompt })));
    imaging = null;
    renderGallery();
    $('gallery').prepend(failed);
    setTimeout(() => failed.remove(), 15000);
  } finally {
    clearInterval(tick);
    imaging = null;
    $('imgGo').textContent = 'Generate';
    poll();
  }
}

// ------------------------------------------------------------------ toasts

function toast(text) {
  const t = el('div', { class: 'toast', role: 'status', text });
  $('toasts').append(t);
  setTimeout(() => t.remove(), 5000);
}

// ------------------------------------------------------------------ wiring

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  if (running) return running.abort();
  const input = $('input');
  const text = input.value;
  input.value = '';
  input.style.height = '';
  send(text);
});

$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('composer').requestSubmit();
  } else if (e.key === 'ArrowUp' && !e.target.value) {
    // Recall the last thing you sent.
    const last = [...messages].reverse().find((m) => m.role === 'user');
    if (last) {
      e.preventDefault();
      e.target.value = last.content;
      e.target.dispatchEvent(new Event('input'));
    }
  }
});
$('input').addEventListener('input', (e) => {
  e.target.style.height = '';
  e.target.style.height = `${Math.min(e.target.scrollHeight + 2, 220)}px`;
});
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  if (e.key === 'Escape' && (running || imaging)) {
    running?.abort();
    imaging?.controller.abort();
  } else if (e.key === '/' && !typing) {
    e.preventDefault();
    ($('imagesView').hidden ? $('input') : $('imgPrompt')).focus();
  } else if (e.altKey && e.code === 'KeyN') {
    e.preventDefault();
    startNewChat();
  }
});

$('new').addEventListener('click', startNewChat);
$('tabChat').addEventListener('click', () => setView('chat'));
$('tabImages').addEventListener('click', () => setView('images'));
$('imgForm').addEventListener('submit', (e) => {
  e.preventDefault();
  generate();
});
$('imgPrompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!imaging) generate();
  }
});
for (const id of ['imgSize', 'imgCount', 'imgModel']) $(id).addEventListener('change', (e) => store.set(`aic.${id}`, e.target.value));
$('imgEnhance').addEventListener('change', (e) => store.set('aic.imgEnhance', e.target.checked));
$('chat').addEventListener('change', (e) => switchChat(chats.find((c) => c.id === e.target.value) ?? chat));
$('export').addEventListener('click', exportChat);
$('delete').addEventListener('click', () => {
  if (messages.length && !confirm(`Delete "${chat.title || 'this chat'}"? This cannot be undone.`)) return;
  chats = chats.filter((c) => c !== chat);
  if (!chats.length) chats = [newChat()];
  store.set('aic.chats', chats);
  switchChat(chats[0]);
});
$('system').addEventListener('input', (e) => {
  chat.system = e.target.value;
  saveChats();
});
$('attach').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', (e) => {
  addFiles([...e.target.files]);
  e.target.value = '';
});
const composer = $('composer');
composer.addEventListener('dragover', (e) => {
  if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
  e.preventDefault();
  composer.classList.add('dragging');
});
composer.addEventListener('dragleave', () => composer.classList.remove('dragging'));
composer.addEventListener('drop', (e) => {
  composer.classList.remove('dragging');
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  addFiles([...e.dataTransfer.files]);
});

$('refresh').addEventListener('click', async (e) => {
  e.target.disabled = true;
  e.target.textContent = 'Checking…';
  try {
    setStatus(await api('/api/refresh', {}));
  } catch {
    /* the next poll will report it */
  }
  e.target.disabled = false;
  e.target.textContent = 'Re-check providers';
});

for (const id of ['mode', 'skill', 'model']) {
  $(id).addEventListener('change', (e) => {
    store.set(`aic.${id}`, e.target.value);
    renderHint();
  });
}

async function start() {
  $('mode').value = store.get('aic.mode', '');
  renderChatList();
  renderMessages();
  $('imgSize').value = store.get('aic.imgSize', '1024x1024');
  $('imgCount').value = store.get('aic.imgCount', '1');
  $('imgEnhance').checked = store.get('aic.imgEnhance', false);
  await poll();
  if (store.get('aic.view', 'chat') === 'images') setView('images');
  try {
    skills = (await api('/api/skills')).skills;
    const byCategory = new Map();
    for (const s of skills) byCategory.set(s.category, [...(byCategory.get(s.category) ?? []), s]);
    $('skill').append(
      el('option', { value: 'auto', text: 'Pick one for me' }),
      ...[...byCategory].sort(([a], [b]) => a.localeCompare(b)).map(([category, list]) => el('optgroup', { label: category[0].toUpperCase() + category.slice(1) }, list.map((s) => el('option', { value: s.name, text: s.name, title: s.description })))),
    );
    const saved = store.get('aic.skill', '');
    if ([...$('skill').options].some((o) => o.value === saved)) $('skill').value = saved;
  } catch {
    /* no skills is fine */
  }
  renderHint();
  setInterval(() => {
    if (!document.hidden) poll();
  }, 4000);
  // Keep countdowns moving between polls.
  setInterval(() => {
    if (status && !document.hidden) renderProviders();
  }, 1000);
}

start();
