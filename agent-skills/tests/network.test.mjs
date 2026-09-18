import { describe, expect, it } from 'vitest';
import { Networks } from '@stellar/stellar-sdk';
import { NETWORKS, resolveNetwork } from '../lib/stellar/network.mjs';
import { isValidPublicKey } from '../lib/stellar/strkey.mjs';

describe('network profiles', () => {
  it('uses the passphrases the SDK defines', () => {
    expect(NETWORKS.testnet.passphrase).toBe(Networks.TESTNET);
    expect(NETWORKS.pubnet.passphrase).toBe(Networks.PUBLIC);
  });

  it('marks exactly one network as carrying real value', () => {
    expect(NETWORKS.pubnet.realValue).toBe(true);
    expect(NETWORKS.testnet.realValue).toBe(false);
  });

  it('offers a faucet only where one exists', () => {
    expect(NETWORKS.testnet.friendbotUrl).toBeTruthy();
    expect(NETWORKS.pubnet.friendbotUrl).toBeNull();
  });

  it('carries a well-formed USDC contract id per network', () => {
    for (const profile of Object.values(NETWORKS)) {
      expect(profile.usdcSac).toMatch(/^C[A-Z2-7]{55}$/);
      expect(isValidPublicKey(profile.usdcSac)).toBe(false); // a contract id is not an account
    }
  });
});

describe('resolveNetwork', () => {
  it('accepts the aliases people type', () => {
    for (const alias of ['testnet', 'TESTNET', ' test ', 'stellar:testnet']) {
      expect(resolveNetwork(alias).id).toBe('testnet');
    }
    for (const alias of ['pubnet', 'mainnet', 'public', 'stellar:pubnet']) {
      expect(resolveNetwork(alias).id).toBe('pubnet');
    }
  });

  it('has no default: an unstated network is an error, not a guess', () => {
    for (const value of [undefined, '', null, 'futurenet', 'main']) {
      expect(() => resolveNetwork(/** @type {any} */ (value))).toThrow(/unknown network/);
    }
  });
});
