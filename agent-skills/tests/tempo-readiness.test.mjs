import { describe, expect, it, vi } from 'vitest';
import { tempoReadiness } from '../plugins/algoria/lib/services/tempo-readiness.mjs';
describe('read-only wallet readiness', () => {
  it('provides one actionable setup result without starting a signer', () => {
    const inspect = vi.fn();
    expect(tempoReadiness({ platform: 'linux', inspect }).reason).toBe('unsupported-device');
    expect(tempoReadiness({ platform: 'darwin', app: 'relative.app', inspect }).reason).toBe('companion-missing');
    expect(inspect).not.toHaveBeenCalled();
  });
  it('verifies the companion and only requests its no-key status', () => {
    const inspect = vi.fn().mockReturnValueOnce('').mockReturnValueOnce('{"status":"readiness","keyCreated":false,"touchIDAvailable":true,"permissionVersion":1,"fundingVersion":1,"journeyVersion":1}');
    expect(tempoReadiness({ platform: 'darwin', app: '/tmp/test.app', inspect })).toMatchObject({ ready: true, walletMode: 'disposable', realFundsSupported: false });
    expect(inspect.mock.calls[1][1]).toEqual(['--status']);
  });
  it('fails closed on unavailable biometrics, damaged apps or unexpected status', () => {
    const inspect = vi.fn().mockReturnValueOnce('').mockReturnValueOnce('{"status":"readiness","keyCreated":false,"touchIDAvailable":false,"permissionVersion":1,"fundingVersion":1,"journeyVersion":1}');
    expect(tempoReadiness({ platform: 'darwin', app: '/tmp/test.app', inspect }).reason).toBe('touch-id-unavailable');
    const invalid = vi.fn().mockReturnValue('not-json');
    expect(tempoReadiness({ platform: 'darwin', app: '/tmp/test.app', inspect: invalid }).ready).toBe(false);
  });
  it('requires a safe-funding companion and explains sandbox access failures', () => {
    const old = vi.fn().mockReturnValueOnce('').mockReturnValueOnce('{"status":"readiness","keyCreated":false,"touchIDAvailable":true,"permissionVersion":1}');
    expect(tempoReadiness({ platform: 'darwin', app: '/tmp/test.app', inspect: old }).reason).toBe('companion-unavailable');
    const restricted = vi.fn().mockReturnValueOnce('').mockReturnValueOnce('{"status":"readiness","keyCreated":false,"touchIDAvailable":false,"permissionVersion":1,"fundingVersion":1,"journeyVersion":1}');
    expect(tempoReadiness({ platform: 'darwin', app: '/tmp/test.app', inspect: restricted }).nextAction).toContain('sandbox');
  });
  it('requires the continuous journey protocol before claiming readiness', () => {
    const inspect = vi.fn().mockReturnValueOnce('').mockReturnValueOnce('{"status":"readiness","keyCreated":false,"touchIDAvailable":true,"permissionVersion":1,"fundingVersion":1}');
    expect(tempoReadiness({ platform: 'darwin', app: '/tmp/test.app', inspect }).reason).toBe('companion-unavailable');
  });
});
