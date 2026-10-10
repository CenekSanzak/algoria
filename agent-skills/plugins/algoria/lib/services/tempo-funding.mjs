import { TEMPO_TOKEN } from './tempo-links.mjs';

const balanceAbi = [{ type: 'function', name: 'balanceOf', stateMutability: 'view',
  inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }];
const FEE_SCALE = 1_000_000_000_000n; // attodollars -> six-decimal TIP-20 units (TIP-1010).

/** @param {bigint} amount */
function display(amount) { return `${amount / 1_000_000n}.${String(amount % 1_000_000n).padStart(6, '0')}`; }

/** Shared with the native UI: derives the top-up from the validated purchase,
 * never from caller-authored display amounts or a native ETH balance.
 * @param {any} summary @param {string} balanceAtomic */
export function tempoFundingDetails(summary, balanceAtomic) {
  if (summary.network !== 'Tempo Moderato (42431)' || summary.token !== TEMPO_TOKEN ||
      !/^0x[0-9a-fA-F]{40}$/.test(summary.address) || /^0x0{40}$/.test(summary.address) ||
      !/^[1-9][0-9]{0,6}$/.test(summary.amount) || BigInt(summary.amount) > 1_000_000n ||
      !/^[1-9][0-9]{0,6}$/.test(summary.gasLimit) || BigInt(summary.gasLimit) > 1_000_000n ||
      !/^[1-9][0-9]{0,10}$/.test(summary.maxFeePerGas) || BigInt(summary.maxFeePerGas) > 30_000_000_000n ||
      typeof balanceAtomic !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(balanceAtomic) || BigInt(balanceAtomic) >= 2n ** 256n) {
    throw new Error('Invalid Tempo funding terms');
  }
  const maximumFee = (BigInt(summary.gasLimit) * BigInt(summary.maxFeePerGas) + FEE_SCALE - 1n) / FEE_SCALE;
  const required = BigInt(summary.amount) + maximumFee;
  const balance = BigInt(balanceAtomic);
  const shortfall = balance < required ? required - balance : 0n;
  return { network: 'eip155:42431', token: TEMPO_TOKEN, address: summary.address,
    balanceAtomic, requiredAtomic: String(required), shortfallAtomic: String(shortfall),
    balance: display(balance), required: display(required), shortfall: display(shortfall),
    maximumFee: display(maximumFee), unit: 'test PathUSD', sufficient: shortfall === 0n };
}

export class TempoFundingError extends Error {
  /** @param {'balance-unavailable' | 'funding-cancelled' | 'funding-expired'} code */
  constructor(code) { super(`Tempo wallet funding stopped: ${code}. No payment was signed.`); this.code = code; }
}

/** One bounded, testnet-only faucet request, then fresh token-balance checks.
 * The caller keeps the SAME native process/key alive while asking for tokens.
 * @param {any} rpc @param {any} summary
 * @param {{autoFund?: boolean, expiresAt: number, onStage?: (stage: string) => Promise<void>,
 * onRequired: (details: ReturnType<typeof tempoFundingDetails>) => Promise<boolean>}} options */
export async function ensureTempoFunding(rpc, summary, options) {
  // Validate everything before a faucet write, including the actual RPC chain.
  tempoFundingDetails(summary, '0');
  if (!Number.isFinite(options.expiresAt)) throw new TempoFundingError('funding-expired');
  if (await rpc.getChainId() !== 42431) throw new Error('Tempo network mismatch');
  const active = () => {
    if (Date.now() + 15000 >= options.expiresAt) throw new TempoFundingError('funding-expired');
  };
  const check = async () => {
    active();
    try {
      const balance = await rpc.readContract({ address: TEMPO_TOKEN, abi: balanceAbi,
        functionName: 'balanceOf', args: [summary.address] });
      if (typeof balance !== 'bigint') throw new Error('Invalid balance');
      return tempoFundingDetails(summary, String(balance));
    } catch { throw new TempoFundingError('balance-unavailable'); }
  };
  let funding = await check();
  if (!funding.sufficient && options.autoFund !== false) {
    active();
    await options.onStage?.('funding');
    try {
      const hashes = await rpc.request({ method: 'tempo_fundAddress', params: [summary.address] });
      if (!Array.isArray(hashes) || hashes.length > 16 || hashes.some(hash => typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash))) throw new Error('Invalid faucet response');
      // A faucet failure is not a payment failure. Recheck balance even after a
      // lost reply; never blindly retry the faucet or ask for a second payment.
      await Promise.all(hashes.map(async hash => {
        const receipt = await rpc.waitForTransactionReceipt({ hash, timeout: 30000 });
        if (receipt.status !== 'success') throw new Error('Faucet transfer failed');
      }));
    } catch { /* The verified balance below decides whether user help is needed. */ }
    funding = await check();
  }
  while (!funding.sufficient) {
    active();
    await options.onStage?.('funding-needed');
    if (!await options.onRequired(funding)) throw new TempoFundingError('funding-cancelled');
    funding = await check();
  }
  return funding;
}
