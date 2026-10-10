import { tempoReadiness } from './tempo-readiness.mjs';
import { getBudget } from './state.mjs';
import { apiFetch, serviceUrl } from './api.mjs';
import { loadTempoSdk } from './tempo-sdk.mjs';
import { TEMPO_TOKEN } from './tempo-links.mjs';
import { atomicAmount } from './policy.mjs';

/** Rehearsal check only: no keys, quote POST, faucet, authentication or purchase.
 * Checks current installation, service, RPC and an ALREADY approved budget.
 * @param {{budget: string, service?: string, agent?: string}} options */
export async function tempoPreflight({ budget, service = 'image.generate', agent }) {
  if (!['image.generate', 'phone.call'].includes(service)) throw new Error('Choose image.generate or phone.call');
  if (agent && !['claude', 'codex'].includes(agent)) throw new Error('Choose claude or codex');
  /** @type {{key: string, ready: boolean, message: string}[]} */
  const checks = [];
  const companion = tempoReadiness();
  checks.push({ key: 'companion', ready: companion.ready, message: companion.ready ? 'Local wallet and Touch ID are ready.' : companion.nextAction });
  let offer;
  try {
    const { response, body } = await apiFetch(serviceUrl(service), { headers: { 'X-Payment-Protocol': 'mpp' } }, 15000);
    const value = body.mpp;
    if (!response.ok || body.id !== service || body.resource !== serviceUrl(service) ||
        value?.protocol !== 'mpp' || value.chain !== 'eip155:42431' || value.token !== TEMPO_TOKEN ||
        value.decimals !== 6 || !/^0x[0-9a-f]{40}$/.test(value.recipient) || /^0x0{40}$/.test(value.recipient) ||
        !/^[1-9][0-9]{0,6}$/.test(value.amount) || BigInt(value.amount) > 1_000_000n) throw new Error('Unsupported service');
    offer = value;
    checks.push({ key: 'service', ready: true, message: 'Tempo service metadata is available.' });
  } catch { checks.push({ key: 'service', ready: false, message: 'Check the Tempo backend configuration or connection, then rerun preflight.' }); }
  try {
    const sdk = await loadTempoSdk();
    const rpc = sdk.createPublicClient({ chain: sdk.tempoModerato, transport: sdk.http(undefined, { retryCount: 0, timeout: 15000 }) });
    if (await rpc.getChainId() !== 42431) throw new Error('Wrong chain');
    const fee = await rpc.getGasPrice();
    if (fee <= 0n || fee > 30_000_000_000n) throw new Error('Unsupported fees');
    checks.push({ key: 'network', ready: true, message: 'Tempo testnet is reachable and fees are within the signing cap.' });
  } catch { checks.push({ key: 'network', ready: false, message: 'Check the Tempo testnet connection and fee availability, then rerun preflight.' }); }
  let spending;
  try {
    spending = await getBudget(budget);
    const p = spending.permission;
    const scopeReady = spending.protocol === 'mpp' && p?.state === 'active' && p.service === service &&
      (!agent || p.agent === agent) && p.recipient === offer?.recipient &&
      typeof p.expiresAt === 'string' && Date.parse(p.expiresAt) > Date.now() + 15000;
    checks.push({ key: 'permission', ready: scopeReady, message: scopeReady ? 'Your existing service-scoped permission is active.'
      : 'Review the named budget scope, host label, recipient and expiry with Touch ID. No approval was requested by this check.' });
    const required = offer ? BigInt(offer.amount) * 10n : null;
    const remaining = /^0(?:\.0{1,7})?$/.test(spending.remaining) ? 0n : BigInt(atomicAmount(spending.remaining));
    const limitsReady = required !== null && remaining >= required && BigInt(atomicAmount(spending.perCall)) >= required;
    checks.push({ key: 'limits', ready: limitsReady, message: limitsReady ? 'The remaining budget and per-purchase limit cover one service purchase; fees are separate.'
      : 'Choose a budget with enough remaining allowance and per-purchase limit. Preflight never raises your limits.' });
  } catch { checks.push({ key: 'permission', ready: false, message: 'Create or repair the named Tempo budget with your approved limits and expiry before the demo.' }); }
  const ready = checks.every(check => check.ready);
  return { ready, service, budget, network: 'eip155:42431', unit: 'test PathUSD', checks,
    ...(offer ? { servicePrice: `${BigInt(offer.amount) / 1_000_000n}.${String(BigInt(offer.amount) % 1_000_000n).padStart(6, '0')}`, recipient: offer.recipient } : {}),
    nextAction: ready ? 'Ask for your image or approved call. The purchase will still require Touch ID.' : checks.find(check => !check.ready)?.message,
    paymentAttempted: false, keyCreated: false, faucetRequested: false,
    note: 'Read-only snapshot, not a live signing, faucet or provider test. Wallets remain temporary; no persistent balance is checked.' };
}
