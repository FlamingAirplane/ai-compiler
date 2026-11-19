// Only used to fingerprint a key for the model-list cache, so a fast
// non-cryptographic hash (two FNV-1a variants, 64 bits) is enough here.
export function createHash() {
  let text = '';
  return {
    update(s) {
      text += String(s);
      return this;
    },
    digest() {
      let a = 0x811c9dc5;
      let b = 0x01000193 ^ 0x5bd1e995;
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        a = Math.imul(a ^ c, 0x01000193) >>> 0;
        b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
      }
      return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
    },
  };
}
export default { createHash };
