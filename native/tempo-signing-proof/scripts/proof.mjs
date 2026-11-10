import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPublicClient, http, keccak256, parseAbiItem } from 'viem';
import { tempoModerato } from 'viem/chains';
import { TxEnvelopeTempo, SignatureEnvelope } from 'ox/tempo';
import { addressFor, prepare, TOKEN, MAX_FEE_PER_GAS } from '../src/transaction.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const app = resolve(root, '.build/Algoria Signing Proof.app');
const binary = resolve(app, 'Contents/MacOS/AlgoriaSigningProof');
const args = process.argv.slice(2);
const client = createPublicClient({ chain: tempoModerato, transport: http(undefined, { retryCount: 0, timeout: 15_000 }) });
const json = (value) => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);

async function verifyReceipt(hash, address) {
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000, retryCount: 0 });
  if (receipt.status !== 'success') throw new Error(`Transaction reverted: ${hash}`);
  const logs = await client.getLogs({
    address: TOKEN, event: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'),
    args: { from: address, to: address }, fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber,
  });
  if (!logs.some((log) => log.transactionHash === hash && log.args.value === 1n)) {
    throw new Error('Receipt found but expected test self-transfer is missing.');
  }
  return { status: 'confirmed', transactionHash: hash, blockNumber: receipt.blockNumber,
    address, chainId: 42431, gasUsed: receipt.gasUsed, explorer: `https://explore.testnet.tempo.xyz/tx/${hash}` };
}

let child;
try {
  if (args.length === 2 && args[0] === '--recover') {
    const saved = JSON.parse(await readFile(resolve(args[1]), 'utf8'));
    if (saved.chainId !== 42431 || !/^0x[0-9a-fA-F]{64}$/.test(saved.transactionHash ?? '') ||
        !/^0x[0-9a-fA-F]{40}$/.test(saved.address ?? '')) throw new Error('Invalid proof receipt file.');
    // Read-only recovery: never signs or broadcasts again.
    console.log(json(await verifyReceipt(saved.transactionHash, saved.address)));
  } else if (args.length === 1 && args[0] === '--status') {
    execFileSync(binary, ['--status'], { stdio: 'inherit' });
  } else if (args.length === 2 && args[0] === '--live' && args[1] === '--fund-testnet') {
    if (await client.getChainId() !== 42431) throw new Error('RPC is not Moderato testnet.');
    execFileSync('codesign', ['--verify', '--deep', '--strict', app]);
    child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    const timer = setTimeout(() => child.kill(), 300_000);
    const lines = createInterface({ input: child.stdout });
    let request, publicKey, signed = false;
    try {
      for await (const line of lines) {
        const message = JSON.parse(line);
        if (message.status === 'error') throw new Error(`Native signer: ${message.code}`);
        if (message.status === 'ready') {
          if (request) throw new Error('Duplicate ready response.');
          publicKey = message.publicKey;
          const address = addressFor(publicKey);
          console.log(`Disposable testnet account: ${address}. Requesting faucet tokens; no real funds.`);
          const hashes = await client.request({ method: 'tempo_fundAddress', params: [address] });
          for (const hash of hashes) await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
          const balance = await client.readContract({ address: TOKEN,
            abi: [parseAbiItem('function balanceOf(address) view returns (uint256)')], functionName: 'balanceOf', args: [address] });
          if (balance < 1n) throw new Error('Faucet did not provide test PathUSD.');
          const gasPrice = await client.getGasPrice();
          const fee = gasPrice * 2n;
          if (fee > MAX_FEE_PER_GAS || fee === 0n) throw new Error('Network fees exceed the fixed proof cap.');
          request = { version: 1, chainId: 42431,
            nonce: String(await client.getTransactionCount({ address, blockTag: 'pending' })),
            maxFeePerGas: String(fee), validBefore: Math.floor(Date.now() / 1000) + 180 };
          prepare(request, publicKey);
          child.stdin.end(`${JSON.stringify(request)}\n`);
          console.log('Review the native window and use Touch ID. Cancelling will not broadcast a payment.');
        } else if (message.status === 'signed') {
          if (!request || signed) throw new Error('Unexpected signature response.');
          signed = true;
          const expected = prepare(request, publicKey);
          const raw = message.result.serializedTransaction;
          const tx = TxEnvelopeTempo.deserialize(raw);
          if (TxEnvelopeTempo.getSignPayload(tx) !== expected.digest ||
              !SignatureEnvelope.verify(tx.signature, { payload: expected.digest, address: expected.summary.address })) {
            throw new Error('Native response differs from requested proof.');
          }
          const transactionHash = keccak256(raw);
          const record = { status: 'signed-before-broadcast', chainId: 42431,
            transactionHash, address: expected.summary.address, request, publicKey };
          await mkdir(resolve(root, 'artifacts'), { recursive: true, mode: 0o700 });
          const path = resolve(root, 'artifacts', `${randomUUID()}.json`);
          // Save identity before the only send attempt. Do not persist private keys.
          await writeFile(path, json(record), { flag: 'wx', mode: 0o600 });
          console.log(`Recovery record: ${path}`);
          try {
            const returnedHash = await client.sendRawTransaction({ serializedTransaction: raw });
            if (returnedHash !== transactionHash) throw new Error('RPC returned an unexpected transaction hash.');
            const receipt = await verifyReceipt(transactionHash, record.address);
            await writeFile(path, json({ ...record, ...receipt }), { mode: 0o600 });
            console.log(json(receipt));
          } catch (error) {
            throw new Error(`Submission/settlement is uncertain. Do not run another purchase to recover it. Use --recover ${path}. ${error.shortMessage ?? error.message}`);
          }
        } else throw new Error('Unexpected native response.');
      }
      if (!signed) throw new Error('Signer exited without a signature; nothing broadcast.');
    } finally { clearTimeout(timer); }
  } else {
    throw new Error('Use --status, --live --fund-testnet, or --recover <receipt-file>. Live mode opens native consent and Touch ID; testnet only.');
  }
} catch (error) {
  console.error(error.shortMessage ?? error.message);
  process.exitCode = 1;
} finally { child?.kill(); }
