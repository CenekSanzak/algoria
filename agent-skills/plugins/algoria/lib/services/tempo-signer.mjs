import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { loadTempoSdk } from './tempo-sdk.mjs';

/** Native app is configured outside the shipped plugin. No keys cross this pipe.
 * @param {any} job @param {{fundTestnet?: boolean}} options
 * @param {(record: any) => Promise<void>} saveBeforeBroadcast
 */
export async function signAndPayTempo(job, options, saveBeforeBroadcast) {
  const app = process.env.ALGORIA_TEMPO_SIGNER_APP;
  if (process.platform !== 'darwin' || !app?.endsWith('.app') || !app.startsWith('/')) {
    throw new Error('Set ALGORIA_TEMPO_SIGNER_APP to the built native companion .app on a Touch ID Mac');
  }
  if (!options.fundTestnet) throw new Error('Disposable companion wallet requires explicit --fund-testnet');
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'ignore' });
  const sdk = await loadTempoSdk();
  const rpc = sdk.createPublicClient({ chain: sdk.tempoModerato,
    transport: sdk.http(undefined, { retryCount: 0, timeout: 15000 }) });
  if (await rpc.getChainId() !== 42431) throw new Error('Tempo network mismatch');
  const child = spawn(`${app}/Contents/MacOS/AlgoriaSigningProof`, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = createInterface({ input: child.stdout });
  child.on('error', () => lines.close());
  child.stdin.on('error', () => lines.close());
  const timer = setTimeout(() => child.kill(), 300000);
  try {
    let request;
    let ready = false;
    let publicKey;
    for await (const line of lines) {
      if (line.length > 100000) throw new Error('Native signing response too large');
      const message = JSON.parse(line);
      if (message.status === 'error') throw new Error('Native purchase approval cancelled or denied');
      if (message.status === 'ready' && !ready) {
        ready = true;
        publicKey = message.publicKey;
        const address = sdk.preparePurchase({ version: 2, chainId: 42431,
          nonce: '0', maxFeePerGas: '1', validBefore: Math.floor(Date.now() / 1000) + 120,
          challenge: job.challenge, input: JSON.parse(job.body) }, message.publicKey).summary.address;
        if (options.fundTestnet) {
          // Explicit disposable-wallet funding. Testnet faucet only, no real funds.
          const hashes = await rpc.request({ method: 'tempo_fundAddress', params: [address] });
          if (Array.isArray(hashes)) for (const hash of hashes) await rpc.waitForTransactionReceipt({ hash, timeout: 60000 });
        } else throw new Error('Disposable companion wallet needs explicit --fund-testnet for this development flow');
        request = { version: 2, chainId: 42431,
          nonce: String(await rpc.getTransactionCount({ address, blockTag: 'pending' })),
          maxFeePerGas: String((await rpc.getGasPrice()) * 2n),
          validBefore: Math.min(Math.floor(Date.now() / 1000) + 180, Math.floor(Date.parse(job.expiresAt) / 1000)),
          challenge: job.challenge, input: JSON.parse(job.body) };
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
        await rpc.waitForTransactionReceipt({ hash, timeout: 60000 });
        return { transaction, credential, payer: prepared.summary.address };
      }
    }
    throw new Error('Native signer exited before approving the purchase');
  } finally { clearTimeout(timer); lines.close(); child.kill(); }
}
