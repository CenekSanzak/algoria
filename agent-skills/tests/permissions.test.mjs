import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { signedPermission } from './helpers/permission.mjs';
const home = await mkdtemp(join(tmpdir(), 'algoria-permissions-'));
process.env.ALGORIA_HOME = home;
const approval = await import('../plugins/algoria/lib/services/permission-approval.mjs');
const { PERMISSION_RESOURCE } = await import('../plugins/algoria/lib/services/permission-schema.mjs');
const state = await import('../plugins/algoria/lib/services/state.mjs');
const recipient = '0x1111111111111111111111111111111111111111';
const scope = () => ({ agent: 'codex', recipient, expires: new Date(Date.now() + 3600000).toISOString() });
beforeEach(async () => {
  await rm(state.ledgerPath(), { force: true });
  vi.spyOn(approval, 'approvePermission').mockImplementation(async p => signedPermission(p));
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => rm(home, { recursive: true, force: true }));
async function grant() { return state.setBudget('demo', '0.03', '0.02', 'mpp', scope()); }
async function job(patch = {}) {
  const id = randomUUID();
  await state.editLedger(s => { s.jobs[id] = { id, budget: 'demo', protocol: 'mpp', chain: 'eip155:42431',
    service: 'image.generate', resource: PERMISSION_RESOURCE, tokenAsset: '0x20c0000000000000000000000000000000000000',
    offer: { payTo: recipient, amount: '10000' }, ...patch }; });
  return id;
}
describe('biometric-approved local spending permissions', () => {
  it('signs exact scopes, exposes no signature and requires approval for changes', async () => {
    const budget = await grant();
    expect(budget.permission).toMatchObject({ state: 'active', agent: 'codex', enforcement: 'local-only', purchaseTouchIDRequired: true });
    expect(JSON.stringify(budget)).not.toContain('signature');
    const first = budget.permission?.id;
    const next = await state.setBudget('demo', '0.04', '0.02', 'mpp', scope());
    expect(next.permission?.id).not.toBe(first);
    expect(approval.approvePermission).toHaveBeenCalledTimes(2);
    expect((await state.readLedger()).budgets.demo.permission.policy.previousId).toBe(first);
  });
  it('cancellation of a grant or expansion leaves the budget unchanged', async () => {
    vi.mocked(approval.approvePermission).mockRejectedValueOnce(new Error('cancelled'));
    await expect(grant()).rejects.toThrow('cancelled');
    expect((await state.readLedger()).budgets.demo).toBeUndefined();
    await grant(); const before = await state.readLedger();
    vi.mocked(approval.approvePermission).mockRejectedValueOnce(new Error('Touch ID denied'));
    await expect(state.setBudget('demo', '0.04', '0.03', 'mpp', scope())).rejects.toThrow('denied');
    expect(await state.readLedger()).toEqual(before);
  });
  it('rejects mismatched biometric approval and unsigned legacy budgets', async () => {
    vi.mocked(approval.approvePermission).mockImplementationOnce(async p => signedPermission({ ...p, totalAtomic: '400000' }));
    await expect(grant()).rejects.toThrow('changed');
    await state.editLedger(s => { s.budgets.demo = { total: '300000', perCall: '200000', protocol: 'mpp', reservations: {} }; });
    expect((await state.getBudget('demo')).permission?.state).toBe('approval-required');
    await expect(state.reserveBudget(await job(), '100000')).rejects.toThrow('permission');
  });
  it('rejects tampered limits, signature, destination, service and chain', async () => {
    await grant();
    for (const patch of [{ offer: { payTo: '0x2222222222222222222222222222222222222222' } }, { service: 'video.social' }, { chain: 'eip155:1' }]) {
      await expect(state.reserveBudget(await job(patch), '100000')).rejects.toThrow('outside');
    }
    await state.editLedger(s => { s.budgets.demo.total = '400000'; });
    await expect(state.reserveBudget(await job(), '100000')).rejects.toThrow('differs');
    await state.editLedger(s => { s.budgets.demo.total = '300000'; s.budgets.demo.permission.policy.totalAtomic = '400000'; });
    await expect(state.reserveBudget(await job(), '100000')).rejects.toThrow('receipt');
  });
  it('enforces total atomically across concurrent tasks and per-call limits', async () => {
    await grant();
    await expect(state.reserveBudget(await job(), '210000')).rejects.toThrow('outside');
    const ids = await Promise.all([job(), job()]);
    const results = await Promise.allSettled(ids.map(id => state.reserveBudget(id, '200000')));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((await state.getBudget('demo')).reserved).toBe('0.0200000');
  });
  it('preserves usage when changing or regranting a revoked budget', async () => {
    await grant(); const id = await job(); await state.reserveBudget(id, '100000');
    await state.revokeBudget('demo');
    await state.setBudget('demo', '0.04', '0.02', 'mpp', scope());
    expect((await state.getBudget('demo')).reserved).toBe('0.0100000');
    await expect(state.setBudget('demo', '0.001', '0.001', 'mpp', scope())).rejects.toThrow('already spent');
  });
  it('expiry fails before reservation and again before dispatch', async () => {
    await grant(); const id = await job(); await state.reserveBudget(id, '100000');
    const p = (await state.readLedger()).budgets.demo.permission.policy;
    const now = Math.floor(Date.now() / 1000);
    await state.editLedger(s => { s.budgets.demo.permission = signedPermission({ ...p, validAfter: now - 100, validUntil: now - 1 }); });
    await expect(state.purchasePermission(id)).rejects.toThrow('expired');
    await expect(state.saveTempoDispatch(id, { transaction: 'hash' })).rejects.toThrow('expired');
    expect((await state.readJob(id)).dispatchedAt).toBeUndefined();
  });
  it('immediate revocation blocks queued/final dispatch without erasing reservations', async () => {
    await grant(); const id = await job(); await state.reserveBudget(id, '100000');
    expect((await state.revokeBudget('demo')).revocation).toBe('local-effective');
    await expect(state.purchasePermission(id)).rejects.toThrow('revoked');
    await expect(state.saveTempoDispatch(id, { transaction: 'hash' })).rejects.toThrow('revoked');
    expect((await state.getBudget('demo')).reserved).toBe('0.0100000');
    expect((await state.readJob(id)).dispatchedAt).toBeUndefined();
  });
  it('cannot overwrite a revocation that arrived during biometric approval', async () => {
    await grant();
    vi.mocked(approval.approvePermission).mockImplementationOnce(async p => {
      await state.revokeBudget('demo'); return signedPermission(p);
    });
    await expect(state.setBudget('demo', '0.04', '0.02', 'mpp', scope())).rejects.toThrow('changed during');
    expect((await state.getBudget('demo')).permission?.state).toBe('revoked');
  });
  it('saves one dispatch only, and preserves the record after revocation', async () => {
    await grant(); const id = await job(); await state.reserveBudget(id, '100000');
    await state.saveTempoDispatch(id, { transaction: 'original-hash' });
    await expect(state.saveTempoDispatch(id, { transaction: 'different-hash' })).rejects.toThrow('already saved');
    await state.revokeBudget('demo');
    expect((await state.readJob(id)).transaction).toBe('original-hash');
    expect((await state.getBudget('demo')).reserved).toBe('0.0100000');
  });
  it('can review the same undispatched task under a replacement without resetting its usage', async () => {
    await grant(); const id = await job(); await state.reserveBudget(id, '100000');
    const oldId = (await state.readJob(id)).permissionId;
    await state.setBudget('demo', '0.04', '0.02', 'mpp', scope());
    // A previously queued approval cannot silently adopt the replacement.
    await expect(state.purchasePermission(id)).rejects.toThrow('permission changed');
    // A new explicit same-task run can review the newly approved policy.
    await state.reserveBudget(id, '100000');
    expect((await state.purchasePermission(id)).policy.id).not.toBe(oldId);
    expect((await state.getBudget('demo')).reserved).toBe('0.0100000');
    await state.saveTempoDispatch(id, { transaction: 'only-hash' });
    await expect(state.reserveBudget(id, '100000')).rejects.toThrow('recover');
  });
  it('rejects missing scope, overlong expiry and zero recipient before native UI', async () => {
    await expect(state.setBudget('demo', '0.03', '0.02', 'mpp')).rejects.toThrow('scope');
    await expect(state.setBudget('demo', '0.03', '0.02', 'mpp', { ...scope(), expires: new Date(Date.now() + 40 * 86400000).toISOString() })).rejects.toThrow('limits');
    await expect(state.setBudget('demo', '0.03', '0.02', 'mpp', { ...scope(), recipient: '0x' + '0'.repeat(40) })).rejects.toThrow('scope');
    expect(approval.approvePermission).not.toHaveBeenCalled();
  });
});
