// Prints what Tatum's Sui gRPC gateway actually returns, so the field names used in suigrpc.js can be checked.
// Usage: TATUM_API_KEY=... node scripts/probe-sui.js [coinType]     (set SUI_GRPC_MODE=web to try gRPC-Web)
import { createSuiClient, SuiReader, analyzePackage } from '../server/lib/adapters/suigrpc.js';

const key = process.env.TATUM_API_KEY;
if (!key) { console.error('Set TATUM_API_KEY first.'); process.exit(1); }
const coin = process.argv[2] || '0x2::sui::SUI';
const show = (label, v) => console.log(`\n--- ${label}\n`, JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 1).slice(0, 1500));
const client = await createSuiClient(key, { mode: process.env.SUI_GRPC_MODE === 'web' ? 'web' : 'native' });
console.log('client services:', Object.keys(client).filter((k) => /Service$/.test(k)).join(', ') || Object.keys(client).join(', '));
const sui = new SuiReader(client);
const step = async (label, fn) => { try { show(label, await fn()); } catch (e) { console.log(`\n--- ${label} FAILED:`, e.code || '', e.message); } };
await step('chainInfo', () => sui.chainInfo());
await step('coinInfo', () => sui.coinInfo(coin));
const pkgId = coin.split('::')[0];
await step('package analysis', async () => { const p = await sui.packageInfo(pkgId); return { moduleCount: p?.modules?.length, sampleFunction: p?.modules?.[0]?.functions?.[0], analysis: analyzePackage(p) }; });
await step('package object', () => sui.objectInfo(pkgId));
process.exit(0);
