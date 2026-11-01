// Third-party sniffer scores (higher score = safer on these services).
import { http } from '../net.js';
import { EVM_CHAINS } from '../chain.js';

export async function sniffScore(settings, chain, address) {
  try {
    if (chain === 'sui') return { available: false, provider: null, reason: 'No sniffer service covers Sui yet' };
    if (chain === 'solana') {
      const key = settings.get('SOLSNIFFER_API_KEY');
      if (!key) return { available: false, provider: 'SolSniffer', reason: 'SolSniffer key not set' };
      const d = await http(`https://solsniffer.com/api/v2/token/${encodeURIComponent(address)}`, { headers: { 'X-API-KEY': key }, timeout: 12000, retries: 1 });
      const score = d?.tokenData?.score ?? d?.score;
      return typeof score === 'number' ? { available: true, provider: 'SolSniffer', score } : { available: false, provider: 'SolSniffer', reason: 'Unexpected response shape' };
    }
    const id = EVM_CHAINS[chain]?.id;
    const key = settings.get('TOKENSNIFFER_API_KEY');
    if (!id || !key) return { available: false, provider: 'TokenSniffer', reason: key ? 'Chain not supported' : 'TokenSniffer key not set' };
    const d = await http(`https://tokensniffer.com/api/v2/tokens/${id}/${address}?apikey=${encodeURIComponent(key)}&include_metrics=true`, { timeout: 15000, retries: 1 });
    const score = d?.score ?? d?.data?.score;
    return typeof score === 'number' ? { available: true, provider: 'TokenSniffer', score } : { available: false, provider: 'TokenSniffer', reason: 'Unexpected response shape' };
  } catch (e) { return { available: false, provider: chain === 'solana' ? 'SolSniffer' : 'TokenSniffer', reason: e.message }; }
}
