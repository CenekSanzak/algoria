/**
 * The anchor logic that has to be right without a network: amount limits, the
 * testnet-only guard, which statuses are final, and the deposit record that
 * keeps a user from paying twice. ALGORIA_HOME is redirected first, so no test
 * here can touch a real wallet or a real deposit record.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'algoria-anchor-'));
process.env.ALGORIA_HOME = home;

const { assertAnchorNetwork, estimateUsdc, normaliseTryAmount } = await import('../plugins/algoria/lib/anchor/anchor.mjs');
const { isSuccess, isTerminal } = await import('../plugins/algoria/lib/anchor/sep6.mjs');
const { anchorStatePath, findDeposit, latestDeposit, readState, recordDeposit, updateDeposit } = await import(
  '../plugins/algoria/lib/anchor/state.mjs'
);
const { NETWORKS } = await import('../plugins/algoria/lib/stellar/network.mjs');

afterAll(() => rm(home, { recursive: true, force: true }));
beforeEach(() => rm(anchorStatePath(), { force: true }));

/** @type {import('../plugins/algoria/lib/anchor/anchor.mjs').AnchorStatus} */
const STATUS = {
  environment: 'sandbox',
  tryLimits: { min: '50.00', max: '3000' },
  buyRate: '49.029048',
  feePercent: 0.5
};

const deposit = (over = {}) => ({
  id: 'sep_test',
  network: 'testnet',
  publicKey: 'GTEST',
  amountTry: '200.00',
  iban: 'TR05',
  reference: 'TRMA-AAAA',
  payUrl: 'https://tr-mock-anchor.fly.dev/sep6/tx/sep_test',
  status: 'pending_user_transfer_start',
  ...over
});

describe('network guard', () => {
  it('accepts testnet', () => {
    expect(() => assertAnchorNetwork(NETWORKS.testnet)).not.toThrow();
  });

  it('refuses pubnet, because this anchor is a sandbox', () => {
    expect(() => assertAnchorNetwork(NETWORKS.pubnet)).toThrow(/testnet-only/);
  });
});

describe('amounts', () => {
  it('normalises to two decimals, the unit TRY is quoted in', () => {
    expect(normaliseTryAmount('200', STATUS)).toBe('200.00');
    expect(normaliseTryAmount('199.999', STATUS)).toBe('200.00');
  });

  it('enforces the anchor’s live limits rather than a hardcoded pair', () => {
    expect(() => normaliseTryAmount('10', STATUS)).toThrow(/50–3000/);
    expect(() => normaliseTryAmount('5000', STATUS)).toThrow(/50–3000/);
  });

  it('rejects anything that is not a positive number', () => {
    for (const bad of ['', 'abc', '0', '-5', 'undefined']) {
      expect(() => normaliseTryAmount(bad, STATUS)).toThrow();
    }
  });

  it('estimates USDC net of the spread, at seven decimals', () => {
    expect(estimateUsdc('200.00', STATUS)).toBe('4.0588184');
    expect(estimateUsdc('200.00', { ...STATUS, buyRate: '' })).toBeNull();
  });
});

describe('statuses', () => {
  it('treats only finished states as terminal', () => {
    for (const status of ['completed', 'error', 'refunded', 'expired']) expect(isTerminal(status)).toBe(true);
    for (const status of ['pending_user_transfer_start', 'pending_anchor', 'pending_stellar', 'pending_trust']) {
      expect(isTerminal(status)).toBe(false);
    }
  });

  it('does not mistake a terminal status for a successful one', () => {
    expect(isSuccess('completed')).toBe(true);
    expect(isSuccess('error')).toBe(false);
    expect(isSuccess('unknown-future-status')).toBe(false);
  });
});

describe('deposit records', () => {
  it('starts empty and stays readable when the file is missing', async () => {
    expect(await readState()).toEqual({ version: 1, deposits: [] });
    expect(await latestDeposit('GTEST')).toBeNull();
  });

  it('remembers a deposit before the money is sent', async () => {
    const record = await recordDeposit(deposit());
    expect(record.status).toBe('pending_user_transfer_start');
    expect(await findDeposit('sep_test')).toMatchObject({ id: 'sep_test', amountTry: '200.00' });
  });

  it('updates in place rather than accumulating duplicates', async () => {
    await recordDeposit(deposit());
    await updateDeposit('sep_test', { status: 'completed', amountOut: '4.07' });
    const state = await readState();
    expect(state.deposits).toHaveLength(1);
    expect(state.deposits[0]).toMatchObject({ status: 'completed', amountOut: '4.07' });
  });

  it('returns the newest deposit for the wallet asking, and ignores other wallets', async () => {
    await recordDeposit(deposit({ id: 'sep_one' }));
    await recordDeposit(deposit({ id: 'sep_two' }));
    await recordDeposit(deposit({ id: 'sep_other', publicKey: 'GOTHER' }));
    expect((await latestDeposit('GTEST'))?.id).toBe('sep_two');
    expect((await latestDeposit('GOTHER'))?.id).toBe('sep_other');
  });

  it('reports nothing for an unknown id instead of inventing one', async () => {
    expect(await findDeposit('sep_missing')).toBeNull();
    expect(await updateDeposit('sep_missing', { status: 'completed' })).toBeNull();
  });
});
