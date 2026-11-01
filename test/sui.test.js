import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzePackage, isImmutableOwner, SuiReader, explainSuiError } from '../server/lib/adapters/suigrpc.js';
import { inspectSui } from '../server/lib/contract.js';
import { Store } from '../server/lib/store.js';
import { loadSecret } from '../server/lib/secret.js';

const fn = (name, { vis = 2, isEntry = false, params = [] } = {}) => ({ name, visibility: vis, isEntry, parameters: params });
const param = (typeName, reference = 0) => ({ reference, body: { typeName } });
const CAP = '0x0000000000000000000000000000000000000000000000000000000000000002::coin::TreasuryCap';

test('a public function taking &mut TreasuryCap is flagged as minting; by-value and private ones are not', () => {
  const mintable = analyzePackage({ modules: [{ name: 'meme', functions: [fn('init', { vis: 1 }), fn('mint', { isEntry: true, params: [param(CAP, 2)] })] }] });
  assert.equal(mintable.treasuryExposed, true);
  assert.deepEqual(mintable.fnNames, ['meme::init', 'meme::mint']);
  assert.equal(analyzePackage({ modules: [{ name: 'm', functions: [fn('burn_cap', { params: [param(CAP, 0)] })] }] }).treasuryExposed, false, 'by value');
  assert.equal(analyzePackage({ modules: [{ name: 'm', functions: [fn('mint', { vis: 1, params: [param(CAP, 2)] })] }] }).treasuryExposed, false, 'private');
  assert.equal(analyzePackage({ modules: [{ name: 'm', functions: [fn('mint', { vis: 'PUBLIC', params: [param(CAP, 'MUTABLE')] })] }] }).treasuryExposed, true, 'string enums');
  assert.equal(analyzePackage({ modules: [{ name: 'm', functions: [fn('x', { params: [param('0x2::coin::DenyCapV2', 2)] })] }] }).denyCap, true);
});

test('owner kinds: only IMMUTABLE counts as frozen', () => {
  assert.equal(isImmutableOwner({ kind: 4 }), true);
  assert.equal(isImmutableOwner({ kind: 'IMMUTABLE' }), true);
  assert.equal(isImmutableOwner({ kind: 'OWNER_KIND_IMMUTABLE' }), true);
  assert.equal(isImmutableOwner({ kind: 1 }), false);
  assert.equal(isImmutableOwner(null), false);
});

test('inspectSui builds the contract record from the gRPC services', async () => {
  const calls = [];
  const client = {
    stateService: { getCoinInfo: async (r) => { calls.push(['coin', r]); return { response: { metadata: { id: '0xmeta', decimals: 9, name: 'Moon', symbol: 'MOON', iconUrl: 'https://i/x.png' }, treasury: { totalSupply: 1000000000n }, regulatedMetadata: undefined } }; } },
    movePackageService: { getPackage: async (r) => { calls.push(['pkg', r]); return { response: { package: { modules: [{ name: 'moon', functions: [fn('mint', { isEntry: true, params: [param(CAP, 2)] })] }] } } }; } },
    ledgerService: {
      getObject: async (r) => { calls.push(['obj', r.objectId]); return { response: { object: r.objectId.endsWith('meta') ? { owner: { kind: 4 } } : { previousTransaction: 'DIGEST1' } } }; },
      getTransaction: async (r) => { calls.push(['tx', r.digest]); return { response: { transaction: { transaction: { sender: '0xABCDEF' } } } }; },
    },
  };
  const tatum = { sui: async () => new SuiReader(client) };
  const { contract, deployer } = await inspectSui(tatum, '0xabc::moon::MOON');
  assert.equal(contract.kind, 'sui'); assert.equal(contract.mintable, true); assert.equal(contract.metadataFrozen, true);
  assert.equal(contract.totalSupplyRaw, '1000000000'); assert.equal(contract.decimals, 9); assert.equal(contract.meta.symbol, 'MOON');
  assert.equal(deployer.address, '0xabcdef');
  assert.equal(calls.find((c) => c[0] === 'pkg')[1].packageId, '0x' + '0'.repeat(61) + 'abc', 'package ids are padded to 32 bytes');
  assert.ok(contract.codeHash);
});

test('a missing service method gives an actionable error', async () => {
  await assert.rejects(new SuiReader({}).chainInfo(), /npm run probe:sui/);
  assert.match(explainSuiError(Object.assign(new Error('x'), { code: 'UNAUTHENTICATED' })).message, /rejected the API key/);
  assert.match(explainSuiError(Object.assign(new Error('x'), { code: 'UNAVAILABLE' })).message, /SUI_GRPC_MODE=web/);
});

test('the session secret lives outside db.json; a legacy secret in db.json triggers a security reset', () => {
  delete process.env.SESSION_SECRET;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-'));
  const st = new Store(dir);
  const s1 = loadSecret(dir, st);
  assert.equal(s1.length, 64); assert.equal(fs.readFileSync(path.join(dir, '.session-secret'), 'utf8'), s1);
  assert.equal(loadSecret(dir, st), s1, 'stable across restarts');
  assert.equal(JSON.stringify(st.data).includes(s1), false, 'never inside db.json');

  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-'));
  const old = new Store(dir2);
  old.set('meta', { sessionSecret: 'leaked-old-secret' }); old.set('settings', { TATUM_API_KEY: { enc: true, v: 'v1:x' } }); old.set('auth', { hash: 'h', salt: 's' });
  const s2 = loadSecret(dir2, old);
  assert.notEqual(s2, 'leaked-old-secret');
  assert.equal(old.get('meta', {}).sessionSecret, undefined);
  assert.deepEqual(old.get('settings', {}), {}); assert.equal(old.get('auth', null), null);

  process.env.SESSION_SECRET = 'from-env';
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-'));
  const env = new Store(dir3); env.set('meta', { sessionSecret: 'leaked' }); env.set('auth', { hash: 'h', salt: 's' });
  assert.equal(loadSecret(dir3, env), 'from-env'); assert.equal(env.get('auth', null), null, 'reset also happens when the secret comes from env');
  delete process.env.SESSION_SECRET;
});
