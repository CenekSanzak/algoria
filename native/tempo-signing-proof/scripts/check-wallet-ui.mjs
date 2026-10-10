import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Requires a built local macOS app; no wallet state, IPC inputs or network.
const executable = fileURLToPath(new URL('../.build/Algoria Signing Proof.app/Contents/MacOS/AlgoriaSigningProof', import.meta.url));
const result = JSON.parse(execFileSync(executable, ['--ui-self-test'], { encoding: 'utf8', timeout: 15000 }));
assert.deepEqual(result, {
  status: 'ui-self-test-passed', keyCreated: false, signed: false, networkRequests: false,
});
console.log('Native UI checks passed: bundled brand fonts/logo, tab actions, compact purchase/funding layouts, funding-only check/cancel, preview isolation, explicit approval, window close, expiry and safe keyboard defaults.');
