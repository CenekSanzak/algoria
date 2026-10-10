import { describe, expect, it, vi } from 'vitest';
import { walletSession } from '../plugins/algoria/lib/services/tempo-wallet-session.mjs';
const transaction = `0x${'a'.repeat(64)}`;
const url = `https://explore.testnet.tempo.xyz/tx/${transaction}`;

describe('read-only wallet presentation session', () => {
  it('deduplicates real stages and excludes credentials, prompts and media URLs', () => {
    const write = vi.fn(), close = vi.fn();
    const session = walletSession('task', write, close);
    const job = { id: 'task', journey: { stage: 'generating' }, transactionUrl: url,
      credential: 'secret', body: 'private prompt', output: { images: [{ url: 'https://private.invalid' }] } };
    session.update(job); session.update(job);
    expect(write).toHaveBeenCalledExactlyOnceWith({ type: 'wallet-progress', stage: 'generating', transaction });
    session.finish({ ...job, journey: { stage: 'ready' } }); session.finish(job); session.update(job);
    expect(write).toHaveBeenCalledTimes(2); expect(close).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[1][0].stage).toBe('ready');
  });
  it('never claims unconfirmed payment or trusts a foreign explorer link', () => {
    const write = vi.fn(); const session = walletSession('task', write, vi.fn());
    session.update({ id: 'task', journey: { stage: 'paid' }, transactionUrl: 'https://evil.invalid/tx/' + transaction });
    expect(write).toHaveBeenLastCalledWith({ type: 'wallet-progress', stage: 'confirming-payment' });
    session.update({ id: 'task', journey: { stage: 'paid' }, payment: { success: true } });
    expect(write).toHaveBeenLastCalledWith({ type: 'wallet-progress', stage: 'paid' });
    session.update({ id: 'other', journey: { stage: 'ready' } });
    expect(write).toHaveBeenCalledTimes(2);
  });
  it('prioritizes uncertainty over success and describes bounded waits as paused', () => {
    const write = vi.fn(); const session = walletSession('task', write, vi.fn());
    session.update({ id: 'task', requiresAttention: true, journey: { stage: 'ready' }, transactionUrl: url });
    expect(write).toHaveBeenLastCalledWith({ type: 'wallet-progress', stage: 'needs-attention', transaction });
    session.finish({ id: 'task', journey: { stage: 'generating' }, transactionUrl: url });
    expect(write).toHaveBeenLastCalledWith({ type: 'wallet-progress', stage: 'paused', transaction });
  });
  it('does not turn a closed presentation pipe into a payment failure', () => {
    const write = vi.fn(() => { throw new Error('closed'); });
    const session = walletSession('task', write, () => { throw new Error('closed'); });
    expect(() => session.update({ id: 'task', journey: { stage: 'generating' } })).not.toThrow();
    expect(() => session.finish({ id: 'task', requiresAttention: true })).not.toThrow();
  });
});
