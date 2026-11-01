import test from 'node:test';
import assert from 'node:assert/strict';
import { Tatum } from '../server/lib/adapters/tatum.js';

const settings = (extra = {}) => ({ get: (key) => ({ TATUM_API_KEY: 'test-mainnet-key', ...extra })[key] || '' });
const fakeSuiClient = { ledgerService: { getServiceInfo: async () => ({ response: { chainId: 'x', checkpointHeight: 4242n } }) } };

test('Sui is read over gRPC with the saved key, Solana over JSON-RPC with x-api-key', async () => {
  let factoryKey, request;
  const tatum = new Tatum(settings(), {
    suiFactory: async (key) => { factoryKey = key; return fakeSuiClient; },
    request: async (url, options) => { request = { url, options }; return { result: 'ok' }; },
  });
  const r = await tatum.ping();
  assert.equal(r.ok, true);
  assert.match(r.detail, /Sui ok \(checkpoint 4242\)/);
  assert.match(r.detail, /Solana ok/);
  assert.equal(factoryKey, 'test-mainnet-key');
  assert.equal(request.url, 'https://solana-mainnet.gateway.tatum.io');
  assert.equal(request.options.headers['x-api-key'], 'test-mainnet-key');
  assert.equal(request.options.body.method, 'getHealth');
});

test('JSON-RPC is refused for Sui so nothing silently hits the retired endpoint', async () => {
  const tatum = new Tatum(settings(), { request: async () => { throw new Error('should not be called'); } });
  await assert.rejects(tatum.rpc('sui', 'suix_getReferenceGasPrice'), /gRPC/);
});

test('a Sui failure is reported on its own and does not hide Solana', async () => {
  const tatum = new Tatum(settings(), {
    suiFactory: async () => ({ ledgerService: { getServiceInfo: async () => { throw Object.assign(new Error('bad key'), { code: 'UNAUTHENTICATED' }); } } }),
    request: async () => ({ result: 'ok' }),
  });
  const r = await tatum.ping();
  assert.equal(r.ok, false);
  assert.match(r.detail, /Sui failed: Tatum rejected the API key for Sui/);
  assert.match(r.detail, /Solana ok/);
});

test('Tatum 401 on Solana explains that an active Mainnet key is required', async () => {
  const tatum = new Tatum(settings(), { request: async () => { throw Object.assign(new Error('unauthorized'), { status: 401 }); } });
  await assert.rejects(tatum.rpc('solana', 'getHealth'), (e) => { assert.equal(e.status, 401); assert.match(e.message, /active and is your Mainnet API key/); return true; });
});

test('a security URL without {address} is ignored instead of failing every scan', async () => {
  const tatum = new Tatum(settings({ TATUM_SECURITY_URL: 'https://sui-mainnet-grpc.gateway.tatum.io' }), { request: async () => { throw new Error('should not be called'); } });
  assert.equal(await tatum.security('sui', '0x2::sui::SUI'), null);
});
