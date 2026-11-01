// The key that encrypts saved API keys and signs admin cookies must NEVER live next to the data it protects.
// Priority: SESSION_SECRET env (Replit Secrets) -> data/.session-secret (gitignored, mode 0600) -> generate a new one.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function loadSecret(dir, store) {
  if (process.env.SESSION_SECRET) return stripLegacy(store, process.env.SESSION_SECRET);
  const file = path.join(dir, '.session-secret');
  try { const s = fs.readFileSync(file, 'utf8').trim(); if (s) return stripLegacy(store, s); } catch { /* first boot */ }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return stripLegacy(store, secret);
}

// Older builds kept the secret inside db.json, where it was copied into db.json.bak and could end up on GitHub.
// If we find it, treat everything it protected as compromised: drop the saved keys and the admin password.
function stripLegacy(store, secret) {
  const meta = store.get('meta', {});
  if (!meta.sessionSecret) return secret;
  delete meta.sessionSecret;
  store.set('meta', meta);
  store.set('settings', {});
  store.set('auth', null);
  console.warn('\n[WalSniff] SECURITY RESET: an old session secret was found inside db.json. Saved API keys and the admin password were cleared. Re-enter your keys (new ones!) and set a new admin password.\n');
  return secret;
}
