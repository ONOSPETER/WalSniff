// Admin authentication: scrypt password hash (or env password), signed expiring cookie tokens, setup code.
import crypto from 'node:crypto';

const sha = (s) => crypto.createHash('sha256').update(s).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(String(a)), sha(String(b)));

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return { salt: salt.toString('hex'), hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
}
export function checkPassword(pw, rec) {
  if (!rec?.hash) return false;
  const h = crypto.scryptSync(pw, Buffer.from(rec.salt, 'hex'), 64);
  return crypto.timingSafeEqual(h, Buffer.from(rec.hash, 'hex'));
}
export function sign(secret, ttlMs) {
  const body = Buffer.from(JSON.stringify({ exp: Date.now() + ttlMs, n: crypto.randomBytes(6).toString('hex') })).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}
export function verify(secret, token) {
  if (!token || !token.includes('.')) return false;
  const [body, mac] = token.split('.');
  const want = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return false;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString()).exp > Date.now(); } catch { return false; }
}

export class Auth {
  constructor(store, secret) {
    this.store = store;
    this.secret = secret; // comes from loadSecret(): env or data/.session-secret, never db.json
    this.setupCode = null;
    if (!this.configured()) {
      this.setupCode = crypto.randomBytes(4).toString('hex');
      console.log(`\n[WalSniff] No admin password yet. Open /admin and use setup code: ${this.setupCode}\n`);
    }
  }
  configured() { return !!(this.store.get('auth', null)?.hash || process.env.ADMIN_PASSWORD); }
  login(pw) {
    const rec = this.store.get('auth', null);
    if (rec?.hash) return checkPassword(pw, rec);
    return !!process.env.ADMIN_PASSWORD && safeEq(pw, process.env.ADMIN_PASSWORD);
  }
  setup(code, pw) {
    if (this.configured() || !this.setupCode || !safeEq(code, this.setupCode)) return false;
    return this.setPassword(pw);
  }
  setPassword(pw) {
    if (typeof pw !== 'string' || pw.length < 10) return false;
    this.store.set('auth', hashPassword(pw));
    this.setupCode = null;
    return true;
  }
  issue() { return sign(this.secret, 12 * 3600 * 1000); }
  valid(token) { return verify(this.secret, token); }
}
