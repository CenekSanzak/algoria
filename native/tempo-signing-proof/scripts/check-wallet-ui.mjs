import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

// Requires a built local macOS app; no wallet state, IPC inputs or network.
const executable = fileURLToPath(new URL('../.build/Algoria Signing Proof.app/Contents/MacOS/AlgoriaSigningProof', import.meta.url));
const result = JSON.parse(execFileSync(executable, ['--ui-self-test'], { encoding: 'utf8', timeout: 15000 }));
assert.deepEqual(result, {
  status: 'ui-self-test-passed', keyCreated: false, signed: false, networkRequests: false,
});
// Keep stdin open while a native UI timer fires. A blocking main-thread read
// would prevent both preparation painting and cancellation from working.
async function protocolFixture(cancel, stage = 'funding') {
  const child = spawn(executable, [cancel ? '--self-test-journey-cancel' : '--self-test-journey-input'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = createInterface({ input: child.stdout });
  const timer = setTimeout(() => child.kill(), 15000);
  let inputTimer;
  const records = [];
  try {
    for await (const line of lines) {
      const message = JSON.parse(line); records.push(message);
      if (message.status === 'journey-input-ready' && !cancel) {
        inputTimer = setTimeout(() => child.stdin.write(JSON.stringify({ type: 'wallet-progress', stage }) + '\n'), 100);
      }
    }
    return records.at(-1);
  } finally { clearTimeout(timer); clearTimeout(inputTimer); child.stdin.destroy(); lines.close(); child.kill(); }
}
assert.deepEqual(await protocolFixture(false), { status: 'journey-input-passed', stage: 'funding', keyCreated: false, signed: false });
assert.deepEqual(await protocolFixture(true), { status: 'journey-cancel-passed', keyCreated: false, signed: false });
assert.deepEqual(await protocolFixture(false, 'ready'), { status: 'error', code: 'INVALID_WALLET_PROGRESS' });
console.log('Native UI checks passed: brand assets, compact layouts, one-window progress, read-only receipt validation, responsive preparation IPC/cancellation, preview isolation, explicit approval, expiry and safe keyboard defaults.');
