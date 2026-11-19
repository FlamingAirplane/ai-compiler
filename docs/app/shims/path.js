// POSIX path helpers for the browser build.
export const sep = '/';
export const delimiter = ':';
export function normalize(p) {
  const abs = p.startsWith('/');
  const out = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return (abs ? '/' : '') + out.join('/') || (abs ? '/' : '.');
}
export const join = (...parts) => normalize(parts.filter((x) => x !== '').join('/'));
export function resolve(...parts) {
  let r = '/';
  for (const p of parts) if (p) r = p.startsWith('/') ? p : `${r}/${p}`;
  return normalize(r);
}
export function dirname(p) {
  const s = p.replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return i < 0 ? '.' : i === 0 ? '/' : s.slice(0, i);
}
export function basename(p, ext) {
  let b = p.replace(/\/+$/, '').split('/').pop();
  if (ext && b.endsWith(ext)) b = b.slice(0, -ext.length);
  return b;
}
export function extname(p) {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i) : '';
}
export const relative = (from, to) => (to.startsWith(`${from}/`) ? to.slice(from.length + 1) : to === from ? '' : to);
export default { sep, delimiter, normalize, join, resolve, dirname, basename, extname, relative };
