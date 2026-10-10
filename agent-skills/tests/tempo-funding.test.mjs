import { describe, expect, it, vi } from 'vitest';
import { ensureTempoFunding, tempoFundingDetails } from '../plugins/algoria/lib/services/tempo-funding.mjs';
import { TEMPO_TOKEN, TEMPO_EXPLORER, tempoTransactionUrl } from '../plugins/algoria/lib/services/tempo-links.mjs';
import { loadTempoSdk } from '../plugins/algoria/lib/services/tempo-sdk.mjs';
import { publicJob } from '../plugins/algoria/lib/services/state.mjs';

const summary = { network: 'Tempo Moderato (42431)', token: TEMPO_TOKEN,
  address: '0x2222222222222222222222222222222222222222', amount: '10000',
  gasLimit: '1000000', maxFeePerGas: '20000000000' };
const hash = `0x${'a'.repeat(64)}`;
function setup() {
  return { rpc: { getChainId: vi.fn().mockResolvedValue(42431),
    readContract: vi.fn().mockResolvedValueOnce(0n).mockResolvedValue(30000n),
    request: vi.fn().mockResolvedValue([hash]), waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }) },
  options: { expiresAt: Date.now() + 180000, onRequired: vi.fn().mockResolvedValue(true), onStage: vi.fn() } };
}

describe('safe Tempo explorer receipts', () => {
  it('uses the pinned SDK testnet explorer and only accepts transaction hashes', async () => {
    expect(TEMPO_EXPLORER).toBe((await loadTempoSdk()).tempoModerato.blockExplorers.default.url);
    expect(tempoTransactionUrl(hash)).toBe(`${TEMPO_EXPLORER}/tx/${hash}`);
    for (const value of [null, '', 'https://evil.test', `${hash}/evil`, '0x1234', {}]) expect(tempoTransactionUrl(value)).toBeNull();
  });
  it('keeps receipts available after completion, provider failure and uncertain recovery', () => {
    for (const status of ['succeeded', 'failed', 'payment-uncertain']) {
      const card = publicJob({ protocol: 'mpp', transaction: hash, status, payment: { success: status !== 'payment-uncertain' } });
      expect(card.transactionUrl).toBe(`${TEMPO_EXPLORER}/tx/${hash}`);
      expect(card.payment.explorerUrl).toBe(card.transactionUrl);
      expect(card.journey.paymentConfirmed).toBe(status !== 'payment-uncertain');
    }
    expect(publicJob({ protocol: 'x402', transaction: hash })).not.toHaveProperty('transactionUrl');
    expect(publicJob({ protocol: 'mpp', transaction: 'malformed' })).not.toHaveProperty('transactionUrl');
    expect(publicJob({ protocol: 'mpp' })).not.toHaveProperty('transactionUrl');
  });
});

describe('Tempo test-token funding', () => {
  it('calculates the price plus worst-case fee in six-decimal token units, rounding up', () => {
    expect(tempoFundingDetails(summary, '12000')).toMatchObject({ requiredAtomic: '30000', shortfallAtomic: '18000',
      maximumFee: '0.020000', required: '0.030000', shortfall: '0.018000', sufficient: false });
    expect(tempoFundingDetails({ ...summary, maxFeePerGas: '1' }, '0').requiredAtomic).toBe('10001');
    expect(tempoFundingDetails({ ...summary, amount: '100000' }, '0').requiredAtomic).toBe('120000');
  });
  it('automatically funds an empty wallet once, waits for receipt, then verifies its token balance', async () => {
    const { rpc, options } = setup();
    expect((await ensureTempoFunding(rpc, summary, options)).sufficient).toBe(true);
    expect(rpc.request).toHaveBeenCalledExactlyOnceWith({ method: 'tempo_fundAddress', params: [summary.address] });
    expect(rpc.waitForTransactionReceipt).toHaveBeenCalledWith({ hash, timeout: 30000 });
    expect(rpc.readContract).toHaveBeenCalledTimes(2);
    expect(rpc.readContract.mock.calls[0][0]).toMatchObject({ address: TEMPO_TOKEN, functionName: 'balanceOf', args: [summary.address] });
    expect(options.onRequired).not.toHaveBeenCalled();
  });
  it('skips the faucet for a sufficient balance', async () => {
    const { rpc, options } = setup(); rpc.readContract.mockReset().mockResolvedValue(30000n);
    await ensureTempoFunding(rpc, summary, options);
    expect(rpc.request).not.toHaveBeenCalled(); expect(options.onRequired).not.toHaveBeenCalled();
  });
  it('asks for only the missing test tokens after faucet failure, then rechecks without retrying it', async () => {
    const { rpc, options } = setup();
    rpc.request.mockRejectedValue(new Error('rate limit containing sensitive RPC detail'));
    rpc.readContract.mockReset().mockResolvedValueOnce(0n).mockResolvedValueOnce(5000n).mockResolvedValue(30000n);
    await ensureTempoFunding(rpc, summary, options);
    expect(options.onRequired).toHaveBeenCalledWith(expect.objectContaining({ shortfall: '0.025000', address: summary.address }));
    expect(rpc.request).toHaveBeenCalledTimes(1); expect(rpc.readContract).toHaveBeenCalledTimes(3);
    expect(options.onStage).toHaveBeenCalledWith('funding-needed');
  });
  it('rechecks a lost faucet response before asking the user to fund', async () => {
    const { rpc, options } = setup(); rpc.request.mockRejectedValue(new Error('lost reply'));
    await ensureTempoFunding(rpc, summary, options);
    expect(options.onRequired).not.toHaveBeenCalled();
  });
  it('supports manual-only funding and repeated balance checks without repeated faucet requests', async () => {
    const { rpc, options } = setup();
    rpc.readContract.mockReset().mockResolvedValueOnce(0n).mockResolvedValueOnce(20000n).mockResolvedValue(30000n);
    await ensureTempoFunding(rpc, summary, { ...options, autoFund: false });
    expect(rpc.request).not.toHaveBeenCalled(); expect(options.onRequired).toHaveBeenCalledTimes(2);
  });
  it('stops safely on cancellation, quote expiry, malformed faucet replies and reverted faucet transfers', async () => {
    for (const failure of ['cancel', 'malformed', 'reverted']) {
      const { rpc, options } = setup();
      rpc.readContract.mockReset().mockResolvedValue(0n);
      options.onRequired.mockResolvedValue(false);
      if (failure === 'malformed') rpc.request.mockResolvedValue(['bad-hash']);
      if (failure === 'reverted') rpc.waitForTransactionReceipt.mockResolvedValue({ status: 'reverted' });
      await expect(ensureTempoFunding(rpc, summary, options)).rejects.toMatchObject({ code: 'funding-cancelled' });
      expect(options.onRequired).toHaveBeenCalledTimes(1);
    }
    const { rpc, options } = setup();
    await expect(ensureTempoFunding(rpc, summary, { ...options, expiresAt: Date.now() })).rejects.toMatchObject({ code: 'funding-expired' });
    expect(rpc.request).not.toHaveBeenCalled(); expect(rpc.readContract).not.toHaveBeenCalled();
  });
  it('never treats an unknown balance as empty or leaks the RPC error', async () => {
    const { rpc, options } = setup(); rpc.readContract.mockReset().mockRejectedValue(new Error('private RPC credential'));
    await expect(ensureTempoFunding(rpc, summary, options)).rejects.toMatchObject({ code: 'balance-unavailable' });
    expect(rpc.request).not.toHaveBeenCalled(); expect(options.onRequired).not.toHaveBeenCalled();
  });
  it('rejects mainnet, wrong tokens, invalid fee bounds and unsafe balances before funding', async () => {
    const { rpc, options } = setup(); rpc.getChainId.mockResolvedValue(4217);
    await expect(ensureTempoFunding(rpc, summary, options)).rejects.toThrow('network mismatch');
    expect(rpc.request).not.toHaveBeenCalled(); expect(rpc.readContract).not.toHaveBeenCalled();
    for (const patch of [{ network: 'Tempo Mainnet' }, { token: '0xdead' }, { address: `0x${'0'.repeat(40)}` },
      { amount: '1000001' }, { maxFeePerGas: '30000000001' }, { gasLimit: '1000001' }]) {
      expect(() => tempoFundingDetails({ ...summary, ...patch }, '0')).toThrow('Invalid');
    }
    for (const balance of ['-1', '0x01', '1.5', '01', String(2n ** 256n)]) expect(() => tempoFundingDetails(summary, balance)).toThrow('Invalid');
  });
});
