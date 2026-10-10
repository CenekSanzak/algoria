import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { signedPermission } from './helpers/permission.mjs';
import { TEMPO_TOKEN } from '../plugins/algoria/lib/services/tempo-links.mjs';

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal(), spawn: vi.fn(), execFileSync: vi.fn(),
}));
const { spawn } = await import('node:child_process');
const sdkLoader = await import('../plugins/algoria/lib/services/tempo-sdk.mjs');
const sdk = await sdkLoader.loadTempoSdk();
const state = await import('../plugins/algoria/lib/services/state.mjs');
const { signAndPayTempo } = await import('../plugins/algoria/lib/services/tempo-signer.mjs');
const home = await mkdtemp(join(tmpdir(), 'algoria-signer-funding-'));
const originalHome = process.env.ALGORIA_HOME, originalApp = process.env.ALGORIA_TEMPO_SIGNER_APP;
/** @type {any} */ let child;
/** @type {any} */ let rpc;
/** @type {any} */ let job;
/** @type {any[]} */ let inputs;
let cancelFunding = false;

beforeEach(() => {
  vi.stubGlobal('process', new Proxy(process, { get(target, key) { return key === 'platform' ? 'darwin' : Reflect.get(target, key); } }));
  process.env.ALGORIA_HOME = home;
  process.env.ALGORIA_TEMPO_SIGNER_APP = '/tmp/offline-fixture.app';
  inputs = []; cancelFunding = false;
  const now = Math.floor(Date.now() / 1000);
  const recipient = '0x1111111111111111111111111111111111111111';
  const id = randomUUID(), resource = 'https://vqqbvydiehuwdzbgvmun.supabase.co/functions/v1/api/v1/services/image.generate';
  const input = { prompt: 'Offline fixture' };
  const challenge = sdk.Challenge.from({ secretKey: 'offline-fixture'.repeat(3), method: 'tempo', intent: 'charge',
    realm: 'vqqbvydiehuwdzbgvmun.supabase.co', expires: new Date((now + 600) * 1000).toISOString(),
    meta: { resource, job_id: id, input_hash: createHash('sha256').update(JSON.stringify({ service: 'image.generate', input })).digest('hex') },
    request: { amount: '10000', currency: TEMPO_TOKEN, recipient,
      methodDetails: { chainId: 42431, supportedModes: ['push'] } } });
  const permission = signedPermission({ version: 1, id: randomUUID(), budget: 'images', agent: 'codex', service: 'image.generate',
    resource, network: 'eip155:42431', token: challenge.request.currency, recipient, totalAtomic: '1000000',
    perCallAtomic: '1000000', validAfter: now - 1, validUntil: now + 600, previousId: null });
  vi.spyOn(state, 'purchasePermission').mockResolvedValue(permission);
  job = { id, challenge, body: JSON.stringify(input), expiresAt: challenge.expires };
  rpc = { getChainId: vi.fn().mockResolvedValue(42431), getGasPrice: vi.fn().mockResolvedValue(20000000000n),
    readContract: vi.fn().mockResolvedValueOnce(0n).mockResolvedValue(40000n),
    request: vi.fn().mockResolvedValue([`0x${'a'.repeat(64)}`]),
    waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
    getTransactionCount: vi.fn().mockResolvedValue(0), sendRawTransaction: vi.fn() };
  vi.spyOn(sdkLoader, 'loadTempoSdk').mockResolvedValue({ ...sdk, createPublicClient: () => rpc });
  const publicKey = '0x' + generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey
    .export({ type: 'spki', format: 'der' }).subarray(-65).toString('hex');
  child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.kill = vi.fn();
  let buffer = '';
  child.stdin.on('data', (/** @type {Buffer} */ data) => {
    buffer += data.toString();
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n');
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); inputs.push(message);
      if (message.type === 'funding-required') {
        // No real window/key/signature. Simulate the user checking or cancelling.
        child.stdout.write(JSON.stringify(cancelFunding ? { status: 'error', code: 'FUNDING_CANCELLED_OR_EXPIRED' }
          : { status: 'funding-checked', signed: false }) + '\n');
      } else child.stdout.write('{"status":"error","code":"USER_CANCELLED"}\n');
    }
  });
  vi.mocked(spawn).mockImplementation(() => {
    queueMicrotask(() => child.stdout.write(JSON.stringify({ status: 'ready', publicKey, fundingVersion: 1 }) + '\n'));
    return child;
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.mocked(spawn).mockReset(); vi.unstubAllGlobals(); });
afterAll(async () => {
  if (originalHome === undefined) delete process.env.ALGORIA_HOME; else process.env.ALGORIA_HOME = originalHome;
  if (originalApp === undefined) delete process.env.ALGORIA_TEMPO_SIGNER_APP; else process.env.ALGORIA_TEMPO_SIGNER_APP = originalApp;
  await rm(home, { recursive: true, force: true });
});

describe('native funding bridge (offline process and RPC fixtures)', () => {
  it('automatically funds and verifies before sending the purchase review, with fees capped', async () => {
    const save = vi.fn();
    await expect(signAndPayTempo(job, {}, save)).rejects.toThrow('cancelled');
    expect(rpc.request).toHaveBeenCalledTimes(1); expect(rpc.readContract).toHaveBeenCalledTimes(2);
    expect(inputs).toHaveLength(1); expect(inputs[0].version).toBe(2);
    expect(inputs[0].maxFeePerGas).toBe('30000000000');
    expect(save).not.toHaveBeenCalled(); expect(rpc.sendRawTransaction).not.toHaveBeenCalled(); expect(child.kill).toHaveBeenCalled();
  });
  it('keeps the same native process/address for manual top-up before a separate purchase review', async () => {
    rpc.request.mockRejectedValue(new Error('faucet limited'));
    rpc.readContract.mockReset().mockResolvedValueOnce(0n).mockResolvedValueOnce(5000n).mockResolvedValue(40000n);
    await expect(signAndPayTempo(job, {}, vi.fn())).rejects.toThrow('cancelled');
    expect(spawn).toHaveBeenCalledTimes(1); expect(inputs).toHaveLength(2);
    expect(inputs[0].type).toBe('funding-required'); expect(inputs[0].balanceAtomic).toBe('5000');
    expect(inputs[1].version).toBe(2);
    expect(inputs[0].request.challenge.id).toBe(inputs[1].challenge.id);
    expect(rpc.request).toHaveBeenCalledTimes(1); expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
  });
  it('never forwards a purchase for signing when top-up is cancelled', async () => {
    rpc.readContract.mockReset().mockResolvedValue(0n); cancelFunding = true;
    const save = vi.fn();
    await expect(signAndPayTempo(job, { fundTestnet: false }, save)).rejects.toMatchObject({ code: 'funding-cancelled' });
    expect(inputs).toHaveLength(1); expect(inputs[0].type).toBe('funding-required');
    expect(rpc.request).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled(); expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
  });
  it('stops before funding or review if the token balance cannot be read', async () => {
    rpc.readContract.mockReset().mockRejectedValue(new Error('RPC unavailable'));
    await expect(signAndPayTempo(job, {}, vi.fn())).rejects.toMatchObject({ code: 'balance-unavailable' });
    expect(inputs).toHaveLength(0); expect(rpc.request).not.toHaveBeenCalled(); expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
  });
});
