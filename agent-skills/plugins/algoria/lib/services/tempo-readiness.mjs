import { execFileSync } from 'node:child_process';

/** Read-only: no key creation, faucet, RPC, authentication prompt or payment.
 * @param {{platform?: string, app?: string, inspect?: typeof execFileSync}} [options]
 */
export function tempoReadiness({ platform = process.platform, app = process.env.ALGORIA_TEMPO_SIGNER_APP, inspect = execFileSync } = {}) {
  const base = { protocol: 'mpp', network: 'eip155:42431', unit: 'test PathUSD', walletMode: 'disposable', realFundsSupported: false, permissionsEnabled: true, permissionEnforcement: 'local-only', delegatedSigningEnabled: false };
  if (platform !== 'darwin') return { ...base, ready: false, reason: 'unsupported-device', nextAction: 'Use a Touch ID-capable Mac for native Tempo signing.' };
  if (!app?.startsWith('/') || !app.endsWith('.app')) return { ...base, ready: false, reason: 'companion-missing', nextAction: 'Build the local companion and set ALGORIA_TEMPO_SIGNER_APP to its absolute .app path.' };
  try {
    inspect('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'ignore', timeout: 10000 });
    const output = inspect(`${app}/Contents/MacOS/AlgoriaSigningProof`, ['--status'], { encoding: 'utf8', timeout: 10000, maxBuffer: 32768 });
    const status = JSON.parse(String(output));
    if (status.status !== 'readiness' || status.keyCreated !== false) throw new Error('Unexpected companion');
    if (status.permissionVersion !== 1) throw new Error('Rebuild companion for spending permissions');
    if (status.touchIDAvailable !== true) return { ...base, ready: false, reason: 'touch-id-unavailable', nextAction: 'Enable Touch ID on this Mac and unlock it. There is no password or software-key fallback.' };
    return { ...base, ready: true, reason: 'ready', nextAction: 'Review the purchase in the local wallet. Explicit testnet faucet consent is required for each disposable wallet.', fundingRequired: true };
  } catch { return { ...base, ready: false, reason: 'companion-unavailable', nextAction: 'Rebuild or repair the configured companion, then check readiness again. No payment was attempted.' }; }
}
