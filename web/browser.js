// The browser version's "server". The chat page (app.js) talks to the local
// HTTP API; here the same requests are answered inside the page by the same
// core code, which calls AI providers straight from the browser. API keys
// live in an encrypted vault; images live in IndexedDB.

import { createCore } from './core/gateway.js';
import { parseSkill } from './core/skills.js';
import { Vault } from './vault.js';
import { ImageDB } from './imagedb.js';

const BASE = new URL('.', import.meta.url);
const vault = new Vault();
const images = new ImageDB();
const BROWSER_TOOLS = new Set(['calculator', 'current_time', 'wikipedia', 'web_search']);
let core = null;

window.AIC_BROWSER = true;

/** fetch for the core: Wikipedia needs origin=* for browser requests, and browsers set their own User-Agent. */
function browserFetch(input, init = {}) {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (/(^|\.)wikipedia\.org$/.test(url.hostname) && url.pathname.endsWith('/api.php')) url.searchParams.set('origin', '*');
  const headers = new Headers(init.headers ?? {});
  headers.delete('user-agent');
  return fetch(url, { ...init, headers });
}

/** Only the agent tools that can work from a web page. */
function limitTools(c) {
  const base = c.tools;
  c.tools = {
    workspace: null,
    describe: () => base.describe().filter((t) => BROWSER_TOOLS.has(t.name)),
    specs: (names) => base.specs(names).filter((s) => BROWSER_TOOLS.has(s.function.name)),
    run: (name, args, opts) => (BROWSER_TOOLS.has(name) ? base.run(name, args, opts) : Promise.resolve(`Error: there is no tool called "${name}" available.`)),
  };
}

async function init() {
  const [catalog, skills] = await Promise.all(['core/catalog.json', 'core/skills.json'].map((f) => fetch(new URL(f, BASE)).then((r) => r.json())));
  core = createCore({
    memory: true,
    catalogData: catalog,
    env: {},
    fetch: browserFetch,
    usageFile: '/aic/usage.json',
    modelsFile: '/aic/models.json',
    skillsDir: '/no-skills',
  });
  core.skills = new Map(skills.map((s) => parseSkill(s.text, s.name)).filter((s) => s.prompt).map((s) => [s.name, s]));
  limitTools(core);
  if (await vault.resume()) await applyVault();
  mountControls();
  if (vault.exists() && !vault.unlocked()) unlock();
}

const ready = init();

/** Give the core the unlocked keys, skipping any name this version no longer uses. */
async function applyVault() {
  const known = Object.fromEntries(Object.entries(vault.keys).filter(([k]) => core.keyNames.includes(k)));
  if (Object.keys(known).length) await core.setKeys(known);
}

// ------------------------------------------------------------- dialogs

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

/**
 * A passphrase dialog. `check` gets the passphrase and returns an error
 * message, or nothing when it is accepted. Resolves true when accepted,
 * false when cancelled.
 */
function passphraseDialog({ title, text, confirm = false, submit, check, extra }) {
  return new Promise((resolve) => {
    const pass = el('input', { type: 'password', autocomplete: confirm ? 'new-password' : 'current-password', placeholder: 'Passphrase', 'aria-label': 'Passphrase', required: true, minlength: 8 });
    const again = confirm ? el('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Type it again', 'aria-label': 'Type the passphrase again', required: true }) : null;
    const error = el('p', { class: 'vault-error', role: 'alert' });
    const go = el('button', { type: 'submit', class: 'primary', text: submit });
    const cancel = el('button', { type: 'button', class: 'ghost', text: 'Not now' });
    const dialog = el('dialog', { class: 'vault' });
    const form = el('form', { method: 'dialog' }, el('h2', { text: title }), el('p', { text }), pass, again, error, extra ?? null, el('div', { class: 'vault-actions' }, cancel, go));
    dialog.append(form);
    document.body.append(dialog);
    const close = (ok) => {
      dialog.close();
      dialog.remove();
      resolve(ok);
    };
    cancel.addEventListener('click', () => close(false));
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      close(false);
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (again && pass.value !== again.value) return (error.textContent = 'The two passphrases do not match.');
      go.disabled = true;
      go.textContent = 'Working…';
      const problem = await check(pass.value);
      go.disabled = false;
      go.textContent = submit;
      if (problem) {
        error.textContent = problem;
        pass.select();
      } else close(true);
    });
    dialog.showModal();
    pass.focus();
  });
}

function createVault() {
  return passphraseDialog({
    title: 'Protect your keys with a passphrase',
    text: 'Your API keys will be encrypted with this passphrase and kept only in this browser. You will be asked for it once each time you open the app in a new tab. If you forget it, use Forget keys and add them again.',
    confirm: true,
    submit: 'Save keys',
    check: async (p) => {
      try {
        await vault.create(p);
      } catch (err) {
        return err.message;
      }
    },
  });
}

async function unlock() {
  const ok = await passphraseDialog({
    title: 'Unlock your keys',
    text: 'Your API keys are encrypted in this browser. Enter your passphrase to use them. Without it you can still use the providers that need no key.',
    submit: 'Unlock',
    check: async (p) => ((await vault.unlock(p)) ? null : 'That passphrase did not unlock the keys.'),
  });
  if (ok) await applyVault();
  updateControls();
  return ok;
}

// ------------------------------------------------------------- header controls

let controls = null;

function mountControls() {
  const lockBtn = el('button', { type: 'button', class: 'ghost', title: 'Forget the unlocked keys in this tab until you unlock again' });
  const forgetBtn = el('button', { type: 'button', class: 'ghost', text: 'Forget keys', title: 'Delete the saved keys from this browser' });
  lockBtn.addEventListener('click', async () => {
    if (vault.unlocked()) {
      vault.lock();
      await core.setKeys(Object.fromEntries(core.keyNames.map((n) => [n, ''])));
      updateControls();
      toast('Keys locked. They stay saved, encrypted, until you unlock them again.');
    } else {
      await unlock();
    }
  });
  forgetBtn.addEventListener('click', async () => {
    if (!confirm('Delete every saved API key from this browser? This cannot be undone; you would add them again.')) return;
    vault.forget();
    await core.setKeys(Object.fromEntries(core.keyNames.map((n) => [n, ''])));
    updateControls();
    toast('Keys deleted from this browser.');
  });
  controls = { lockBtn, forgetBtn };
  const refresh = document.getElementById('refresh');
  refresh.before(el('span', { class: 'vault-controls' }, lockBtn, forgetBtn));
  updateControls();
}

function updateControls() {
  if (!controls) return;
  const has = vault.exists();
  controls.lockBtn.hidden = !has;
  controls.forgetBtn.hidden = !has;
  controls.lockBtn.textContent = vault.unlocked() ? 'Lock keys' : 'Unlock keys';
}

function toast(text) {
  const box = document.getElementById('toasts');
  const t = el('div', { class: 'toast', role: 'status', text });
  box?.append(t);
  setTimeout(() => t.remove(), 5000);
}

// ------------------------------------------------------------- the API

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fail = (status, code, message, extra = {}) => json(status, { error: { message, type: 'aic_error', code, ...extra } });

async function saveKeys(vars) {
  const adding = Object.values(vars ?? {}).some((v) => String(v ?? '').trim());
  if (!vault.unlocked()) {
    if (!vault.exists()) {
      if (!adding) return null;
      if (!(await createVault())) return 'Keys were not saved: choose a passphrase to protect them.';
    } else if (!(await unlock())) return 'Keys were not saved: the key vault is still locked.';
  }
  const clean = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, String(v ?? '').trim()]));
  await core.setKeys(clean); // validates names and values first
  await vault.update(clean);
  updateControls();
  return null;
}

async function route(path, method, body, signal) {
  if (method === 'GET' && path === '/api/status') {
    core.ready().catch(() => {}); // look up model lists in the background, as the server does
    return json(200, core.status());
  }
  if (method === 'GET' && path === '/api/skills') return json(200, { skills: core.skillList() });
  if (method === 'GET' && path === '/api/images') return json(200, { images: await images.list() });
  if (method !== 'POST') return null;
  switch (path) {
    case '/v1/chat/completions':
      return core.chat(body, { signal });
    case '/api/keys': {
      try {
        const problem = await saveKeys(body.vars ?? {});
        if (problem) return fail(400, 'not_saved', problem);
      } catch (err) {
        return fail(err.failure?.status ?? 400, err.failure?.code ?? 'bad_key', err.failure?.message ?? err.message);
      }
      return json(200, core.status());
    }
    case '/api/refresh':
      return json(200, await core.refresh());
    case '/api/test': {
      const results = body.provider ? [await core.testProvider(String(body.provider), { signal })] : await core.testAll({ signal });
      return json(200, { results, status: core.status() });
    }
    case '/v1/images/generations': {
      let out;
      try {
        out = await core.generateImages(body, { signal });
      } catch (err) {
        if (!err.failure) throw err;
        const f = err.failure;
        return fail(f.status ?? 502, f.code, f.message, { retry_at: f.retryAt ? new Date(f.retryAt).toISOString() : null });
      }
      const data = [];
      for (const { b64, ...meta } of out.images) {
        const file = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.${meta.mime === 'image/png' ? 'png' : meta.mime === 'image/webp' ? 'webp' : 'jpg'}`;
        const blob = new Blob([Buffer.from(b64, 'base64')], { type: meta.mime });
        const src = await images.add({ ...meta, file }, blob);
        data.push(body.response_format === 'url' ? { url: src } : { b64_json: b64 });
      }
      return json(200, { created: Math.floor(Date.now() / 1000), data, aic: { prompt: out.prompt, revisedPrompt: out.revisedPrompt, partial: out.partial, attempts: out.attempts } });
    }
    case '/api/images/delete':
      await images.remove(String(body.file ?? ''));
      return json(200, { ok: true, images: await images.list() });
    default:
      return null;
  }
}

/** Used by app.js in place of fetch for its API calls. Anything else goes to the network. */
window.AIC_FETCH = async (input, init = {}) => {
  const url = new URL(String(input instanceof Request ? input.url : input), location.href);
  if (url.origin === location.origin && /^\/(api|v1)\//.test(url.pathname)) {
    await ready;
    const method = (init.method ?? 'GET').toUpperCase();
    let body = {};
    try {
      body = init.body ? JSON.parse(init.body) : {};
    } catch {
      return fail(400, 'invalid_request', 'The request body is not valid JSON.');
    }
    try {
      const res = await route(url.pathname, method, body, init.signal);
      if (res) return res;
    } catch (err) {
      if (init.signal?.aborted) throw Object.assign(new Error('The request was cancelled.'), { name: 'AbortError' });
      return fail(500, 'internal_error', String(err?.message ?? err));
    }
    return fail(404, 'not_found', 'Not available in the browser version.');
  }
  return fetch(input, init);
};
