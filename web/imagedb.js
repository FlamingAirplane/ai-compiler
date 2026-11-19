// Saved images for the browser version, in IndexedDB (which, unlike
// localStorage, holds megabytes comfortably). Each record is the image's
// details plus its bytes as a Blob.

const MAX = 300;

export class ImageDB {
  constructor(name = 'aic') {
    this.name = name;
    this.urls = new Map(); // file -> object URL, so images are not re-decoded on every redraw
  }

  db() {
    this.opening ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(this.name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('images', { keyPath: 'file' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.opening;
  }

  async run(mode, fn) {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('images', mode);
      const req = fn(tx.objectStore('images'));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  src(record) {
    if (!this.urls.has(record.file)) this.urls.set(record.file, URL.createObjectURL(record.blob));
    return this.urls.get(record.file);
  }

  async list() {
    const all = (await this.run('readonly', (s) => s.getAll())) ?? [];
    all.sort((a, b) => b.at - a.at);
    return all.map(({ blob, ...meta }) => ({ ...meta, src: this.src({ file: meta.file, blob }) }));
  }

  async add(meta, blob) {
    await this.run('readwrite', (s) => s.put({ ...meta, blob }));
    const all = await this.list();
    for (const old of all.slice(MAX)) await this.remove(old.file);
    return this.src({ file: meta.file, blob });
  }

  async remove(file) {
    await this.run('readwrite', (s) => s.delete(file));
    if (this.urls.has(file)) URL.revokeObjectURL(this.urls.get(file));
    this.urls.delete(file);
  }
}
