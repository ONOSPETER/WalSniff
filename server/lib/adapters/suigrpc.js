// Sui reads over Tatum's gRPC gateway. Tatum no longer serves Sui JSON-RPC (see https://docs.tatum.io/reference/rpc-sui),
// so everything WalSniff needs for Sui goes through the Sui gRPC services: Ledger, State and MovePackage.
export const SUI_GRPC_HOST = 'sui-mainnet-grpc.gateway.tatum.io';

const str = (v) => (v === undefined || v === null ? null : String(v));
const padId = (id) => '0x' + String(id).replace(/^0x/i, '').toLowerCase().padStart(64, '0');
const enumIs = (v, num, name) => { const u = String(v).toUpperCase(); return v === num || u === name || u.endsWith('_' + name); };

// "native" = HTTP/2 gRPC through @grpc/grpc-js. "web" = gRPC-Web over fetch (no extra transport package, for hosts that block HTTP/2).
export async function createSuiClient(apiKey, { host = SUI_GRPC_HOST, mode = 'native' } = {}) {
  const { SuiGrpcClient } = await import('@mysten/sui/grpc');
  if (mode === 'web') return new SuiGrpcClient({ network: 'mainnet', baseUrl: `https://${host}`, meta: { 'x-api-key': apiKey } });
  const [{ GrpcTransport }, { ChannelCredentials }] = await Promise.all([import('@protobuf-ts/grpc-transport'), import('@grpc/grpc-js')]);
  const transport = new GrpcTransport({ host: `${host}:443`, channelCredentials: ChannelCredentials.createSsl(), meta: { 'x-api-key': apiKey } });
  return new SuiGrpcClient({ network: 'mainnet', transport });
}

// OwnerKind: 1 ADDRESS, 2 OBJECT, 3 SHARED, 4 IMMUTABLE, 5 CONSENSUS_ADDRESS
export const isImmutableOwner = (owner) => !!owner && enumIs(owner.kind, 4, 'IMMUTABLE');

// Scans a Move package (GetPackage response) for the signals WalSniff cares about.
export function analyzePackage(pkg) {
  let treasuryExposed = false, denyCap = false;
  const fnNames = [];
  for (const m of pkg?.modules || []) {
    for (const fn of m.functions || []) {
      fnNames.push(`${m.name}::${fn.name}`);
      const exposed = fn.isEntry === true || enumIs(fn.visibility, 2, 'PUBLIC'); // Visibility: 1 PRIVATE, 2 PUBLIC, 3 FRIEND
      for (const p of fn.parameters || []) {
        const type = String(p?.body?.typeName ?? '');
        // Reference: 1 IMMUTABLE, 2 MUTABLE. A callable function taking &mut TreasuryCap can mint.
        if (exposed && /::coin::TreasuryCap$/i.test(type) && enumIs(p.reference, 2, 'MUTABLE')) treasuryExposed = true;
        if (/::coin::DenyCap(V2)?$/i.test(type)) denyCap = true;
      }
    }
  }
  return { treasuryExposed, denyCap, fnNames };
}

export class SuiReader {
  constructor(client) { this.c = client; }
  async call(service, method, request) {
    const svc = this.c?.[service];
    if (typeof svc?.[method] !== 'function') throw new Error(`The installed @mysten/sui client has no ${service}.${method}. Run "npm run probe:sui" and compare with the Sui gRPC docs.`);
    const res = await svc[method](request);
    return res?.response ?? res; // protobuf-ts unary calls resolve to { response }
  }
  async chainInfo() {
    const r = await this.call('ledgerService', 'getServiceInfo', {});
    return { chainId: str(r.chainId), chain: str(r.chain), checkpoint: str(r.checkpointHeight) };
  }
  async coinInfo(coinType) {
    const r = await this.call('stateService', 'getCoinInfo', { coinType });
    return { metadata: r.metadata ?? null, supply: str(r.treasury?.totalSupply), regulated: !!r.regulatedMetadata?.denyCapObject };
  }
  async packageInfo(packageId) {
    const r = await this.call('movePackageService', 'getPackage', { packageId: padId(packageId) });
    return r.package ?? r;
  }
  async objectInfo(objectId) {
    const r = await this.call('ledgerService', 'getObject', { objectId: padId(objectId), readMask: { paths: ['owner', 'previous_transaction'] } });
    return r.object ?? r;
  }
  async sender(digest) {
    const r = await this.call('ledgerService', 'getTransaction', { digest, readMask: { paths: ['transaction.sender'] } });
    return r.transaction?.transaction?.sender ?? null;
  }
}

export function explainSuiError(e) {
  const code = String(e?.code ?? '');
  const msg = String(e?.message ?? e);
  if (/UNAUTHENTICATED/i.test(code) || /unauthenticated|401|api_key_invalid/i.test(msg)) return Object.assign(new Error('Tatum rejected the API key for Sui (unauthenticated). Use an active Mainnet key from dashboard.tatum.io.'), { status: 401, cause: e });
  if (/UNAVAILABLE|UNIMPLEMENTED|ECONNRESET|ENOTFOUND|ETIMEDOUT|DEADLINE/i.test(code + msg)) return Object.assign(new Error(`Could not reach Tatum's Sui gRPC gateway (${code || msg.slice(0, 80)}). If your host blocks HTTP/2, set SUI_GRPC_MODE=web and restart.`), { cause: e });
  return e;
}
