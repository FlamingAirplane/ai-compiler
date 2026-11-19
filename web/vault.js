// API keys for the browser version, encrypted at rest with a passphrase.
//
// The passphrase is stretched with PBKDF2 (SHA-256, 600,000 rounds) into an
// AES-GCM key. Only the encrypted blob, its salt and IV are stored, in
// localStorage. Anything that reads that storage (another page on the same
// github.io origin, a backup, a nosy extension reading storage) gets nothing
// usable without the passphrase. While the tab is open the derived key is
// kept in sessionStorage, which belongs to this tab alone and is cleared
// when it closes, so a reload does not ask again.

const ROUNDS = 600_000;
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export class Vault {
  constructor({ storage = globalThis.localStorage, session = globalThis.sessionStorage, name = 'aic.vault', subtle = globalThis.crypto.subtle } = {}) {
    Object.assign(this, { storage, session, name, subtle });
    this.key = null; // the AES key while unlocked
    this.keys = {}; // the API keys while unlocked
  }

  exists() {
    return this.storage.getItem(this.name) !== null;
  }

  unlocked() {
    return this.key !== null;
  }

  async derive(passphrase, salt) {
    const base = await this.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return this.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ROUNDS }, base, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  }

  async remember() {
    try {
      this.session.setItem(`${this.name}.session`, b64(await this.subtle.exportKey('raw', this.key)));
    } catch {
      /* without session storage the passphrase is simply asked again after a reload */
    }
  }

  /** Start a new, empty vault protected by this passphrase. */
  async create(passphrase) {
    if (String(passphrase).length < 8) throw new Error('Use at least 8 characters.');
    const salt = crypto.getRandomValues(new Uint8Array(16));
    this.key = await this.derive(passphrase, salt);
    this.salt = salt;
    this.keys = {};
    await this.write();
    await this.remember();
  }

  async open(key) {
    const v = JSON.parse(this.storage.getItem(this.name));
    const plain = await this.subtle.decrypt({ name: 'AES-GCM', iv: unb64(v.iv) }, key, unb64(v.data));
    this.key = key;
    this.salt = unb64(v.salt);
    this.keys = JSON.parse(dec.decode(plain));
    return this.keys;
  }

  /** Unlock with the passphrase. Returns the keys, or null if the passphrase is wrong. */
  async unlock(passphrase) {
    if (!this.exists()) return null;
    const v = JSON.parse(this.storage.getItem(this.name));
    try {
      const keys = await this.open(await this.derive(passphrase, unb64(v.salt)));
      await this.remember();
      return keys;
    } catch {
      this.key = null;
      return null;
    }
  }

  /** Unlock without asking, if this tab already unlocked it. */
  async resume() {
    const raw = this.session.getItem(`${this.name}.session`);
    if (!raw || !this.exists()) return null;
    try {
      return await this.open(await this.subtle.importKey('raw', unb64(raw), 'AES-GCM', true, ['encrypt', 'decrypt']));
    } catch {
      this.session.removeItem(`${this.name}.session`);
      return null;
    }
  }

  async write() {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await this.subtle.encrypt({ name: 'AES-GCM', iv }, this.key, enc.encode(JSON.stringify(this.keys)));
    this.storage.setItem(this.name, JSON.stringify({ v: 1, kdf: 'PBKDF2-SHA256', rounds: ROUNDS, salt: b64(this.salt), iv: b64(iv), data: b64(data) }));
  }

  /** Set or remove keys (an empty value removes one) and save. */
  async update(vars) {
    if (!this.unlocked()) throw new Error('The key vault is locked.');
    for (const [k, v] of Object.entries(vars)) {
      if (v) this.keys[k] = v;
      else delete this.keys[k];
    }
    await this.write();
    return this.keys;
  }

  lock() {
    this.key = null;
    this.keys = {};
    this.session.removeItem(`${this.name}.session`);
  }

  forget() {
    this.lock();
    this.storage.removeItem(this.name);
  }
}
