import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = '0.1.0';
export const APP = 'ai-compiler';
export const DEFAULT_PORT = Number(process.env.AIC_PORT) || 4141;

export const DEFAULT_CONFIG = {
  // "priority": drain providers in catalog order. "round-robin": rotate between them.
  strategy: 'priority',
  // How many models one request may try before giving up.
  maxAttempts: 8,
  timeoutMs: 45000,
  // When every free tier is resting but one is back within this many
  // milliseconds, wait for it instead of failing straight away.
  waitForQuotaMs: 15000,
  // Routes used for Claude model names on the Anthropic-format endpoint.
  anthropicModels: { default: 'auto', small: 'auto:fast' },
  // Image tiers are slow and some allow one image a minute, so image requests may wait longer.
  images: { waitForQuotaMs: 60000 },
  harness: {
    // Which harness the model name "boost" runs when a skill does not say otherwise.
    boost: 'ensemble',
    ensemble: { proposers: 3 },
    agent: {
      maxSteps: 8,
      // Folder the agent's file tools may read. null turns the file tools off.
      workspace: null,
      allowWrite: false,
      // true runs model-written code inside the macOS sandbox (no network, no
      // access to your home folder). Off by default.
      allowCode: false,
      allowLocalNetwork: false,
    },
  },
};

export function resolvePaths(o = {}) {
  const e = process.env;
  return {
    config: o.config ?? e.AIC_CONFIG ?? join(ROOT, 'config.json'),
    catalog: o.catalog ?? e.AIC_CATALOG ?? join(ROOT, 'providers.json'),
    envFile: o.envFile ?? e.AIC_ENV_FILE ?? join(ROOT, '.env'),
    dataDir: o.dataDir ?? e.AIC_DATA_DIR ?? join(ROOT, 'data'),
    skillsDir: o.skillsDir ?? e.AIC_SKILLS_DIR ?? join(ROOT, 'skills'),
    publicDir: join(ROOT, 'public'),
  };
}

const isPlain = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

export function merge(base, over) {
  if (!isPlain(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isPlain(v) && isPlain(base?.[k]) ? merge(base[k], v) : v;
  return out;
}

export function loadConfig(file, overrides) {
  return merge(merge(DEFAULT_CONFIG, readJson(file, {})), overrides ?? {});
}

export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

export function loadEnvFile(file) {
  return existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
}

/** Set (or, with an empty value, remove) variables in a .env file, keeping other lines. */
export function saveEnvVars(file, vars) {
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/) : [];
  for (const [k, v] of Object.entries(vars)) {
    const re = new RegExp(`^\\s*(?:export\\s+)?${k}\\s*=`);
    const idx = lines.findIndex((l) => re.test(l));
    if (v === '' || v == null) {
      if (idx !== -1) lines.splice(idx, 1);
    } else if (idx === -1) {
      lines.push(`${k}=${v}`);
    } else {
      lines[idx] = `${k}=${v}`;
    }
  }
  while (lines.length && lines.at(-1) === '') lines.pop();
  writeAtomic(file, lines.length ? lines.join('\n') + '\n' : '', 0o600);
}

export function writeAtomic(file, text, mode) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, mode ? { mode } : undefined);
  renameSync(tmp, file);
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
