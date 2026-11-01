// Tatum gateways. Solana and EVM use JSON-RPC (https://<chain>-mainnet.gateway.tatum.io, x-api-key header).
// Sui uses gRPC (https://sui-mainnet-grpc.gateway.tatum.io): Tatum no longer serves Sui JSON-RPC.
import { http } from '../net.js';
import { EVM_CHAINS } from '../chain.js';
import { SuiReader, createSuiClient, explainSuiError } from './suigrpc.js';

function explainTatumError(error) {
  if (error?.status !== 401) return error;
  return Object.assign(
    new Error('Tatum rejected authentication (HTTP 401). WalSniff uses Mainnet gateways; confirm the saved key is active and is your Mainnet API key. The recommended x-api-key header is already being sent.'),
    { status: 401, cause: error },
  );
}

export class Tatum {
  constructor(settings, { request = http, suiFactory = createSuiClient } = {}) { this.s = settings; this.request = request; this.suiFactory = suiFactory; this._sui = null; this._suiKey = ''; }
  get key() { return this.s.get('TATUM_API_KEY'); }
  get ready() { return !!this.key; }
  url(chain) {
    if (chain === 'solana') return 'https://solana-mainnet.gateway.tatum.io';
    const c = EVM_CHAINS[chain];
    if (c) return `https://${c.tatum}.gateway.tatum.io`;
    throw new Error(`Unsupported chain ${chain}`);
  }
  async rpc(chain, method, params = []) {
    if (chain === 'sui') throw new Error('Sui is read over gRPC. Use tatum.sui() instead of tatum.rpc().');
    if (!this.ready) throw new Error('Tatum API key is not set');
    let r;
    try {
      r = await this.request(this.url(chain), { method: 'POST', headers: { 'x-api-key': this.key }, body: { jsonrpc: '2.0', id: 1, method, params }, minGapMs: 60, timeout: 12000 });
    } catch (e) { throw explainTatumError(e); }
    if (r?.error) throw new Error(`${method}: ${r.error.message || 'rpc error'}`);
    return r?.result;
  }
  // Cached Sui reader; rebuilt when the saved key changes.
  async sui() {
    if (!this.ready) throw new Error('Tatum API key is not set');
    if (this._sui && this._suiKey === this.key) return this._sui;
    try {
      const client = await this.suiFactory(this.key, { mode: process.env.SUI_GRPC_MODE === 'web' ? 'web' : 'native' });
      this._sui = new SuiReader(client); this._suiKey = this.key;
      return this._sui;
    } catch (e) { throw explainSuiError(e); }
  }
  async security(chain, address) {
    const tpl = this.s.get('TATUM_SECURITY_URL');
    if (!tpl || !tpl.includes('{address}') || !this.ready) return null; // a URL without {address} is a settings mistake, not a scan failure
    const url = tpl.replace('{chain}', encodeURIComponent(chain)).replace('{address}', encodeURIComponent(address));
    if (!/^https:\/\/[^/]*tatum\.io\//.test(url)) throw new Error('Security endpoint must be an https tatum.io URL');
    try { return await this.request(url, { headers: { 'x-api-key': this.key }, timeout: 12000 }); }
    catch (e) { throw explainTatumError(e); }
  }
  // Checks the two chains WalSniff leans on most: Sui over gRPC and Solana over JSON-RPC.
  async ping() {
    const [sui, sol] = await Promise.allSettled([
      this.sui().then((r) => r.chainInfo()).catch((e) => { throw explainSuiError(e); }),
      this.rpc('solana', 'getHealth'),
    ]);
    const part = (name, r, ok) => (r.status === 'fulfilled' ? `${name} ok${ok ? ` (${ok(r.value)})` : ''}` : `${name} failed: ${String(r.reason?.message || r.reason).slice(0, 140)}`);
    const detail = [part('Sui', sui, (v) => `checkpoint ${v.checkpoint ?? '?'}`), part('Solana', sol)].join(' | ');
    return { ok: sui.status === 'fulfilled' && sol.status === 'fulfilled', detail };
  }
}
