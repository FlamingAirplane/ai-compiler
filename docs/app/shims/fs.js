// A tiny file system on localStorage, for the usage counters and model cache.
// Only what the shared code calls is here. Every write gets a fresh mtime so
// other tabs notice the change, the same way other processes do on a disk.
const P = 'aic.fs:';
const M = 'aic.fs.meta:';
let seq = 0;
const enoent = (p) => Object.assign(new Error(`ENOENT: no such file, '${p}'`), { code: 'ENOENT' });
const has = (p) => localStorage.getItem(P + p) !== null;
const touch = (p) => localStorage.setItem(M + p, String(Date.now() + ++seq / 1000));

export function existsSync(p) {
  return has(p);
}
export function readFileSync(p) {
  const v = localStorage.getItem(P + p);
  if (v === null) throw enoent(p);
  return v;
}
export function writeFileSync(p, data) {
  localStorage.setItem(P + p, String(data));
  touch(p);
}
export function renameSync(a, b) {
  const v = readFileSync(a);
  writeFileSync(b, v);
  unlinkSync(a);
}
export function unlinkSync(p) {
  if (!has(p)) throw enoent(p);
  localStorage.removeItem(P + p);
  localStorage.removeItem(M + p);
}
export function statSync(p) {
  if (!has(p)) throw enoent(p);
  return { mtimeMs: Number(localStorage.getItem(M + p)) || 0, size: localStorage.getItem(P + p).length, isDirectory: () => false, isFile: () => true };
}
export function openSync(p, flags) {
  if (flags === 'wx' && has(p)) throw Object.assign(new Error(`EEXIST: '${p}'`), { code: 'EEXIST' });
  writeFileSync(p, '');
  return 1;
}
export const closeSync = () => {};
export const chmodSync = () => {}; // file permissions mean nothing in localStorage
export const mkdirSync = () => {};
export const readdirSync = () => [];
export const realpathSync = (p) => p;
export const rmSync = () => {};
export const mkdtempSync = (prefix) => `${prefix}${Math.random().toString(36).slice(2)}`;
export default { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync, openSync, closeSync, chmodSync, mkdirSync, readdirSync, realpathSync, rmSync, mkdtempSync };
