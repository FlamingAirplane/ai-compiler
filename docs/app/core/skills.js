// Skills are Markdown files in skills/: a few lines of settings between ---
// markers, then the instructions the model gets. Drop a new file in the folder
// to add one.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const MODES = new Set(['single', 'ensemble', 'refine', 'agent', 'panel']);

const unquote = (s) => s.replace(/^(['"])(.*)\1$/, '$2');

function parseValue(raw) {
  const v = raw.trim();
  if (v.startsWith('[') && v.endsWith(']')) {
    return v
      .slice(1, -1)
      .split(',')
      .map((s) => unquote(s.trim()))
      .filter(Boolean);
  }
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v === 'true') return true;
  if (v === 'false') return false;
  return unquote(v);
}

export function parseSkill(text, fallbackName = 'skill') {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const meta = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
      if (kv) meta[kv[1]] = parseValue(kv[2]);
    }
  }
  const name = String(meta.name ?? fallbackName).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`Skill name "${name}" may only use letters, digits and dashes`);
  const pick = (v) => (MODES.has(v) ? v : null);
  return {
    name,
    description: String(meta.description ?? '').trim(),
    category: String(meta.category ?? 'other').trim().toLowerCase(),
    // Mode used when the skill is called on its own. Tool-driven skills say "agent".
    mode: pick(meta.mode) ?? 'single',
    // Harness used when the caller asks for boost together with this skill.
    boost: pick(meta.boost),
    tier: meta.tier === 'smart' || meta.tier === 'fast' ? meta.tier : null,
    tools: Array.isArray(meta.tools) && meta.tools.length ? meta.tools.map(String) : null,
    temperature: typeof meta.temperature === 'number' ? meta.temperature : null,
    prompt: (m ? m[2] : text).trim(),
  };
}

export function loadSkills(dir) {
  const skills = new Map();
  if (!dir || !existsSync(dir)) return skills;
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.md') || /^readme\.md$/i.test(file)) continue;
    try {
      const skill = parseSkill(readFileSync(join(dir, file), 'utf8'), basename(file, '.md'));
      if (skill.prompt) skills.set(skill.name, skill);
    } catch (err) {
      console.error(`[aic] skipped skill ${file}: ${err.message}`);
    }
  }
  return skills;
}
