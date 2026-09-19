import { afterAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../plugins/algoria/lib/anchor/sep10.mjs', () => ({ authenticate: vi.fn(async () => 'test-session') }));
vi.mock('../plugins/algoria/lib/anchor/anchor.mjs', async (original) => ({
  ...await original(),
  verifyAnchor: vi.fn(async () => ({ environment: 'sandbox', tryLimits: { min: '50', max: '3000' }, buyRate: '40', feePercent: 0.5 }))
}));

const home = await mkdtemp(join(tmpdir(), 'algoria-recovery-'));
process.env.ALGORIA_HOME = home;
const { ensureWallet } = await import('../plugins/algoria/lib/stellar/keystore.mjs');
const { NETWORKS } = await import('../plugins/algoria/lib/stellar/network.mjs');
const { anchorStatePath, findDeposit, recordDeposit } = await import('../plugins/algoria/lib/anchor/state.mjs');
const { main } = await import('../plugins/algoria/skills/algoria-topup/scripts/topup.mjs');
const { entry } = await ensureWallet({ network: 'testnet' });
/** @type {any[]} */
let transactions;
let created = 0;
const order = (id = 'old') => ({ id, status: 'pending_user_transfer_start', amount_in: '200.00' });

beforeEach(async () => {
  await rm(anchorStatePath(), { force: true });
  transactions = [order()]; created = 0; process.exitCode = 0;
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = new URL(String(url));
    if (u.hostname === 'horizon-testnet.stellar.org') return Response.json({ balances: [{ asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: NETWORKS.testnet.usdc.issuer, balance: '2.0000000' }] });
    if (u.pathname === '/sep6/transactions') return Response.json({ transactions });
    if (u.pathname === '/sep6/transaction') return Response.json({ transaction: transactions.find((tx) => tx.id === u.searchParams.get('id')) });
    if (u.pathname === '/sep6/deposit') {
      created++;
      const tx = order(`new-${created}`); transactions.unshift(tx);
      return Response.json({ id: tx.id, instructions: { bank_account_number: { value: 'TR-MOCK' }, external_transfer_memo: { value: tx.id } } });
    }
    throw new Error(`unexpected test request ${u.pathname}`);
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); process.exitCode = 0; });
afterAll(() => rm(home, { recursive: true, force: true }));

describe('topup start reconciliation', () => {
  it('recovers a remote pending deposit instead of creating a duplicate after local loss', async () => {
    await main(['start', '--try', '200', '--json']);
    expect(created).toBe(0);
    expect(await findDeposit('old')).toMatchObject({ publicKey: entry.publicKey, status: 'pending_user_transfer_start' });
    expect(process.exitCode).toBe(0);
  });
  it('refreshes stale local status and permits the next deposit after remote completion', async () => {
    await recordDeposit({ id: 'old', network: 'testnet', publicKey: entry.publicKey, amountTry: '200', iban: 'TR', reference: 'old', payUrl: 'https://tr-mock-anchor.fly.dev/sep6/tx/old', status: 'pending_user_transfer_start' });
    transactions[0].status = 'completed';
    await main(['start', '--try', '200']);
    expect(created).toBe(1);
    expect(await findDeposit('old')).toMatchObject({ status: 'completed' });
  });
  it('persists a deposit recovered through status, then reuses it on start', async () => {
    await main(['status', '--json']);
    expect(await findDeposit('old')).not.toBeNull();
    await main(['start', '--try', '200']);
    expect(created).toBe(0);
  });
  it('stops on ambiguous pending history unless a new deposit is explicitly requested', async () => {
    transactions.push(order('second'));
    await main(['start', '--try', '200']);
    expect(process.exitCode).toBe(1); expect(created).toBe(0);
    process.exitCode = 0;
    await main(['start', '--try', '200', '--new']);
    expect(created).toBe(1);
  });
  it('does not interpret malformed remote history as empty', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => String(url).includes('horizon')
      ? Response.json({ balances: [{ asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: NETWORKS.testnet.usdc.issuer, balance: '2' }] })
      : Response.json({ error: 'unavailable' })));
    await main(['start', '--try', '200']);
    expect(created).toBe(0); expect(process.exitCode).toBe(1);
  });
  it('checks a known older pending deposit omitted from remote history', async () => {
    const saved = { network: 'testnet', publicKey: entry.publicKey, amountTry: '200', iban: 'TR', reference: 'old', payUrl: 'https://tr-mock-anchor.fly.dev/sep6/tx/old' };
    await recordDeposit({ ...saved, id: 'old', status: 'pending_user_transfer_start' });
    await recordDeposit({ ...saved, id: 'newer', status: 'completed' });
    const previousFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const u = new URL(String(url));
      if (u.pathname === '/sep6/transactions') return Response.json({ transactions: [{ ...order('newer'), status: 'completed' }] });
      return previousFetch(url, init);
    }));
    await main(['start', '--try', '200']);
    expect(created).toBe(0); expect(process.exitCode).toBe(0);
  });
});
