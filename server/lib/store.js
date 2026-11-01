// Tiny JSON document store with atomic writes and crash-safe recovery.
// Collections are plain arrays/objects held in memory and flushed to disk (debounced).
import fs from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'db.json');
    this.data = {};
    this.timer = null;
    fs.mkdirSync(dir, { recursive: true });
    this.load();
  }
  load() {
    for (const f of [this.file, this.file + '.bak']) {
      try {
        this.data = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (f.endsWith('.bak')) console.warn('[store] recovered from backup');
        return;
      } catch { /* try next */ }
    }
    this.data = {};
  }
  get(name, fallback) {
    if (!(name in this.data)) this.data[name] = typeof fallback === 'function' ? fallback() : fallback;
    return this.data[name];
  }
  set(name, value) { this.data[name] = value; this.save(); return value; }
  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 250);
  }
  flush() {
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.file + '.bak');
      fs.renameSync(tmp, this.file);
    } catch (e) { console.error('[store] flush failed:', e.message); }
  }
}
