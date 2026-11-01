// Settings registry. Secrets are AES-256-GCM encrypted at rest; env vars act as fallback.
import crypto from 'node:crypto';

export const DEFS = [
  { key: 'TATUM_API_KEY', group: 'Tatum', label: 'Tatum API key', secret: true, help: 'Powers Sui, Ethereum and Solana RPC reads. Get one at dashboard.tatum.io.' },
  { key: 'TATUM_SECURITY_URL', group: 'Tatum', label: 'Tatum security endpoint (optional)', help: 'URL template with {chain} and {address}. Leave empty to skip. Check the Tatum Security API docs for the exact path.' },
  { key: 'MEMWAL_PRIVATE_KEY', group: 'Walrus Memory', label: 'MemWal delegate key', secret: true, help: 'The 32-byte Ed25519 delegate key as 64 hex characters (a 0x prefix is fine). Signs every remember and recall request.' },
  { key: 'MEMWAL_ACCOUNT_ID', group: 'Walrus Memory', label: 'MemWal account ID', help: 'The Walrus Memory account that owns the memories.' },
  { key: 'MEMWAL_SERVER_URL', group: 'Walrus Memory', label: 'Relayer URL', help: 'Walrus Memory relayer endpoint, for example https://your-relayer-url.com.' },
  { key: 'MEMWAL_NAMESPACE_PREFIX', group: 'Walrus Memory', label: 'Namespace prefix', def: 'walsniff', help: 'Each learning session writes to prefix-s{number}.' },
  { key: 'OPENROUTER_API_KEY', group: 'AI verdict', label: 'OpenRouter API key', secret: true, help: 'Used for the AI verdict and pattern analysis. Without it WalSniff writes a rule-based verdict.' },
  { key: 'OPENROUTER_MODEL', group: 'AI verdict', label: 'Model', def: 'anthropic/claude-sonnet-4.5', help: 'Any OpenRouter model ID.' },
  { key: 'TOKENSNIFFER_API_KEY', group: 'Sniffer scores', label: 'TokenSniffer API key', secret: true, help: 'EVM chains only. TokenSniffer does not cover Sui.' },
  { key: 'SOLSNIFFER_API_KEY', group: 'Sniffer scores', label: 'SolSniffer API key', secret: true, help: 'Used for Solana tokens.' },
  { key: 'ETHERSCAN_API_KEY', group: 'Sniffer scores', label: 'Etherscan V2 API key', secret: true, help: 'Adds verified-source status and the deployer address for EVM tokens.' },
  { key: 'LEARN_WINDOW_HOURS', group: 'Learner', label: 'Discovery window (hours)', def: '48', help: 'How far back a learning session looks for new tokens.' },
  { key: 'LEARN_LIMIT', group: 'Learner', label: 'Tokens per session', def: '300', help: 'Hard cap on tokens analysed in one session.' },
  { key: 'LEARN_CHAINS', group: 'Learner', label: 'Chains', def: 'sui,solana,ethereum', help: 'Comma separated. Supported: sui, solana, ethereum.' },
  { key: 'LEARN_CHAIN_WEIGHTS', group: 'Learner', label: 'Chain weights', def: 'sui:50,solana:30,ethereum:20', help: 'Share of the token limit given to each chain, so one chain cannot crowd out the others.' },
  { key: 'LEARN_CONCURRENCY', group: 'Learner', label: 'Parallel requests', def: '4', help: 'Lower this if your API plan rate limits you.' },
  { key: 'RUG_LIQUIDITY_FLOOR_USD', group: 'Learner', label: 'Rug: liquidity floor (USD)', def: '500', help: 'A token whose liquidity falls below this counts as rugged.' },
  { key: 'RUG_DROP_PCT', group: 'Learner', label: 'Rug: 24h price drop (%)', def: '90', help: 'A 24h drop at least this large counts as rugged.' },
  { key: 'SURVIVOR_MIN_LIQUIDITY_USD', group: 'Learner', label: 'Survivor: minimum liquidity (USD)', def: '5000', help: 'Tokens above this with a calm price count as survivors (the control group).' },
  { key: 'DEMO_MODE', group: 'System', label: 'Demo mode', def: 'auto', help: 'auto = demo data when no Tatum key is set. on / off to force.' },
];

export class Settings {
  constructor(store, secretMaterial) {
    this.store = store;
    this.key = crypto.scryptSync(secretMaterial, 'walsniff-settings-v1', 32);
  }
  enc(text) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
  }
  dec(blob) {
    try {
      const [v, iv, tag, ct] = blob.split(':');
      if (v !== 'v1') return '';
      const d = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
      d.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
    } catch { return ''; }
  }
  stored() { return this.store.get('settings', {}); }
  get(key) {
    const def = DEFS.find((d) => d.key === key);
    const rec = this.stored()[key];
    let v = rec ? (rec.enc ? this.dec(rec.v) : rec.v) : '';
    if (!v) v = process.env[key] || '';
    if (!v && def?.def !== undefined) v = def.def;
    return String(v || '');
  }
  num(key, fallback) { const n = Number(this.get(key)); return Number.isFinite(n) ? n : fallback; }
  set(key, value) {
    const def = DEFS.find((d) => d.key === key);
    if (!def) throw new Error(`Unknown setting ${key}`);
    const all = this.stored();
    const v = String(value ?? '').trim();
    if (!v) delete all[key];
    else all[key] = def.secret ? { enc: true, v: this.enc(v) } : { enc: false, v };
    this.store.set('settings', all);
  }
  mask(v) { return !v ? '' : v.length <= 8 ? '••••' : `••••${v.slice(-4)}`; }
  list() {
    const stored = this.stored();
    return DEFS.map((d) => {
      const v = this.get(d.key);
      const source = stored[d.key] ? 'admin' : (process.env[d.key] ? 'env' : (v ? 'default' : 'unset'));
      return { ...d, value: d.secret ? this.mask(v) : v, isSet: !!v, source };
    });
  }
  demo() {
    const m = this.get('DEMO_MODE');
    if (m === 'on') return true;
    if (m === 'off') return false;
    return !this.get('TATUM_API_KEY');
  }
}
