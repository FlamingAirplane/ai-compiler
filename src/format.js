// Plain-text formatting shared by the CLI and the MCP server.

export function fmtNum(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

export function fmtWait(ms) {
  if (ms <= 0) return 'now';
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.ceil(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const STATES = {
  ready: 'ready',
  cooling: 'rate limited',
  no_key: 'no key',
  rejected: 'key rejected',
  checking: 'checking',
  no_models: 'no models',
  offline: 'not running',
  unreachable: 'unreachable',
};

export const stateLabel = (state) => STATES[state] ?? state;

const BUCKET_ORDER = ['requests/day', 'requests', 'requests/hour', 'requests/minute', 'tokens/day', 'tokens', 'tokens/minute'];

/** The most useful "how much is left" figure a provider has reported in its headers, or null. */
export function reported(p) {
  const [scope, latest] = Object.entries(p.limits ?? {}).sort(([, a], [, b]) => b.at - a.at)[0] ?? [];
  if (!latest) return null;
  for (const key of BUCKET_ORDER) {
    const b = latest.buckets[key];
    if (b && b.remaining != null) {
      const [kind, window] = key.split('/');
      const model = scope !== '*' && p.models.length > 1 ? scope : null;
      return { remaining: b.remaining, limit: b.limit ?? null, kind, window: window ?? null, resetAt: b.resetAt ?? null, at: latest.at, model };
    }
  }
  return null;
}

function leftText(p) {
  const r = reported(p);
  if (r) {
    const unit = r.kind === 'tokens' ? 'tok' : 'req';
    return `${r.model ? `${r.model} ` : ''}${fmtNum(r.remaining)}${r.limit != null ? `/${fmtNum(r.limit)}` : ''} ${unit}${r.window ? `/${r.window}` : ''}`;
  }
  if (p.hint?.rpd && p.state !== 'no_key') return `~${Math.max(0, p.hint.rpd - p.today.requests)}/${p.hint.rpd} req/day (est.)`;
  return '-';
}

function nextText(p, now) {
  switch (p.state) {
    case 'no_key':
      return p.local ? 'install to enable' : `get a key: ${p.signupUrl ?? ''}`;
    case 'cooling':
      return `back in ${fmtWait(p.availableAt - now)}`;
    case 'rejected':
      return 'replace the API key';
    case 'offline':
      return 'start it to use it';
    case 'unreachable':
    case 'no_models':
      return p.problem ?? '';
    default:
      return p.local ? 'unlimited' : `day resets in ${fmtWait(p.resetAt - now)}`;
  }
}

export function table(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? String(c) : String(c).padEnd(widths[i]))).join('  ').trimEnd()).join('\n');
}

export function statusTable(status) {
  const { totals, now } = status;
  const head = `${totals.ready} of ${status.providers.length} providers ready. ${fmtNum(totals.requests)} requests and ${fmtNum(totals.tokens)} tokens used today.`;
  const rows = [['Provider', 'State', 'Used today', 'Left', 'Next']];
  for (const p of status.providers) {
    const used = p.today.requests ? `${p.today.requests} req, ${fmtNum(p.today.tokens)} tok` : '-';
    rows.push([p.name, stateLabel(p.state), used, leftText(p), nextText(p, now)]);
  }
  const out = [head, '', table(rows)];
  if (!totals.configured) out.push('', 'No keys yet. Run "aic serve" and open the dashboard, or add keys to the .env file.');
  return out.join('\n');
}
