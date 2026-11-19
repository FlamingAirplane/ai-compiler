// Globals the shared Node code expects, for the browser build. Loaded as a
// classic script before any module.
(function () {
  if (!window.process) window.process = { env: {}, platform: 'browser', pid: 1, versions: {}, execPath: '' };
  if (window.Buffer) return;
  // Just enough of Node's Buffer for the image code: from/alloc/concat and toString.
  class Buffer extends Uint8Array {
    static from(v, enc) {
      if (v instanceof ArrayBuffer) return new Buffer(v);
      if (ArrayBuffer.isView(v)) return new Buffer(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
      if (Array.isArray(v)) return new Buffer(v);
      if (typeof v === 'string') {
        if (enc === 'base64') {
          const bin = atob(v.replace(/[^A-Za-z0-9+/=]/g, ''));
          const b = new Buffer(bin.length);
          for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
          return b;
        }
        return new Buffer(new TextEncoder().encode(v));
      }
      throw new TypeError('Buffer.from: unsupported value');
    }
    static alloc(n) {
      return new Buffer(n);
    }
    static isBuffer(b) {
      return b instanceof Buffer;
    }
    static byteLength(s) {
      return new TextEncoder().encode(String(s)).length;
    }
    static concat(list) {
      const out = new Buffer(list.reduce((n, b) => n + b.length, 0));
      let o = 0;
      for (const b of list) {
        out.set(b, o);
        o += b.length;
      }
      return out;
    }
    toString(enc = 'utf8', start = 0, end = this.length) {
      const part = this.subarray(start, end);
      if (enc === 'base64') {
        let s = '';
        for (let i = 0; i < part.length; i += 0x8000) s += String.fromCharCode.apply(null, part.subarray(i, i + 0x8000));
        return btoa(s);
      }
      return new TextDecoder().decode(part);
    }
  }
  window.Buffer = Buffer;
})();
