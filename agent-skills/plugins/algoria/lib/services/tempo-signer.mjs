import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { loadTempoSdk } from './tempo-sdk.mjs';
import { withLock } from '../lock.mjs';
import { purchasePermission } from './state.mjs';
import { ensureTempoFunding, TempoFundingError } from './tempo-funding.mjs';

/** Native app is configured outside the shipped plugin. No keys cross this pipe.
 * @param {any} job @param {{fundTestnet?: boolean, onStage?: (stage: string) => Promise<void>}} options
 * @param {(record: any) => Promise<void>} saveBeforeBroadcast
 */
export async function signAndPayTempo(job, options, saveBeforeBroadcast) {
  await options.onStage?.('queued-approval');
  return withLock('tempo-wallet-approval', () => signQueued(job, options, saveBeforeBroadcast), { waitMs: 300000 });
}

/** @param {any} job @param {{fundTestnet?: boolean, onStage?: (stage: string) => Promise<void>}} options
 * @param {(record: any) => Promise<void>} saveBeforeBroadcast */
async function signQueued(job, options, saveBeforeBroadcast) {
  if (Date.parse(job.expiresAt) <= Date.now() + 15000) throw new Error('Quote expired while queued; no signing or funding attempted');
  const permission = await purchasePermission(job.id);
  const app = process.env.ALGORIA_TEMPO_SIGNER_APP;
  if (process.platform !== 'darwin' || !app?.endsWith('.app') || !app.startsWith('/')) {
    throw new Error('Set ALGORIA_TEMPO_SIGNER_APP to the built native companion .app on a Touch ID Mac');
  }
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'ignore' });
  const sdk = await loadTempoSdk();
  const rpc = sdk.createPublicClient({ chain: sdk.tempoModerato,
    transport: sdk.http(undefined, { retryCount: 0, timeout: 15000 }) });
  if (await rpc.getChainId() !== 42431) throw new Error('Tempo network mismatch');
  const child = spawn(`${app}/Contents/MacOS/AlgoriaSigningProof`, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = createInterface({ input: child.stdout });
  const messages = lines[Symbol.asyncIterator]();
  child.on('error', () => lines.close());
  child.stdin.on('error', () => lines.close());
  const timer = setTimeout(() => child.kill(), 300000);
  try {
    let request;
    let ready = false;
    let publicKey;
    while (true) {
      const next = await messages.next();
      if (next.done) break;
      const line = next.value;
      if (line.length > 100000) throw new Error('Native signing response too large');
      const message = JSON.parse(line);
      if (message.status === 'error') throw new Error('Native purchase approval cancelled or denied');
      if (message.status === 'ready' && !ready) {
        if (message.fundingVersion !== 1) throw new Error('Rebuild the native companion for wallet funding');
        ready = true;
        publicKey = message.publicKey;
        const gasPrice = await rpc.getGasPrice();
        if (gasPrice <= 0n || gasPrice > 30_000_000_000n) throw new Error('Tempo gas price exceeds the native signing cap');
        const maxFeePerGas = String(gasPrice * 2n > 30_000_000_000n ? 30_000_000_000n : gasPrice * 2n);
        const fundingExpiry = Math.min(Date.parse(job.expiresAt), permission.policy.validUntil * 1000, Date.now() + 240000);
        const makeRequest = (nonce = '0') => ({ version: 2, chainId: 42431, nonce, maxFeePerGas,
          validBefore: Math.min(Math.floor(Date.now() / 1000) + 180, Math.floor(Date.parse(job.expiresAt) / 1000), permission.policy.validUntil),
          challenge: job.challenge, input: JSON.parse(job.body), permission });
        const preparedFunding = sdk.preparePurchase(makeRequest(), publicKey);
        const address = preparedFunding.summary.address;
        await ensureTempoFunding(rpc, preparedFunding.summary, {
          autoFund: options.fundTestnet !== false, expiresAt: fundingExpiry, onStage: options.onStage,
          onRequired: async funding => {
            // Keep stdin and the SAME enclave key alive until manual funding
            // is checked or cancelled. Never return a dead deposit address.
            await purchasePermission(job.id);
            child.stdin.write(JSON.stringify({ type: 'funding-required', request: makeRequest(),
              balanceAtomic: funding.balanceAtomic, expiresAt: fundingExpiry }) + '\n');
            const response = await messages.next();
            if (response.done || response.value.length > 100000) throw new TempoFundingError('funding-cancelled');
            const status = JSON.parse(response.value);
            if (status.status === 'error') throw new TempoFundingError('funding-cancelled');
            if (status.status !== 'funding-checked') throw new Error('Unexpected native funding response');
            return true;
          },
        });
        request = makeRequest(String(await rpc.getTransactionCount({ address, blockTag: 'pending' })));
        await purchasePermission(job.id);
        await options.onStage?.('review');
        child.stdin.end(JSON.stringify(request) + '\n');
      } else if (message.status === 'signed' && request) {
        const tx = sdk.TxEnvelopeTempo.deserialize(message.result.serializedTransaction);
        // Reconstruct the approved purchase rather than trusting the IPC summary.
        const prepared = sdk.preparePurchase(request, publicKey, Math.floor(Date.now() / 1000));
        if (sdk.TxEnvelopeTempo.getSignPayload(tx) !== prepared.digest ||
            !sdk.SignatureEnvelope.verify(tx.signature, { payload: prepared.digest, address: prepared.summary.address })) throw new Error('Native signed purchase mismatch');
        const transaction = sdk.keccak256(message.result.serializedTransaction);
        const credential = sdk.Credential.serialize({ challenge: job.challenge,
          payload: { type: 'hash', hash: transaction },
          source: `did:pkh:eip155:42431:${prepared.summary.address}` });
        await saveBeforeBroadcast({ transaction, credential, payer: prepared.summary.address });
        // One submission only. Persisted hash survives lost RPC/HTTP responses.
        const hash = await rpc.sendRawTransaction({ serializedTransaction: message.result.serializedTransaction });
        if (hash !== transaction) throw new Error('Unexpected Tempo transaction reference');
        const receipt = await rpc.waitForTransactionReceipt({ hash, timeout: 60000 });
        if (receipt.status !== 'success') throw new Error('Tempo transaction reverted; reconcile the saved payment');
        return { transaction, credential, payer: prepared.summary.address };
      }
    }
    throw new Error('Native signer exited before approving the purchase');
  } finally { clearTimeout(timer); lines.close(); child.kill(); }
}
