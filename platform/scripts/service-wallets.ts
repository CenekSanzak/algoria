import {
  Asset,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from 'npm:@stellar/stellar-sdk@16.2.0';

// Local setup only. No receiving-wallet secret is deployed to the API.
if (!Deno.args.includes('--testnet')) throw new Error('Use --testnet to prepare service recipients.');
const server = new Horizon.Server('https://horizon-testnet.stellar.org');
const usdc = new Asset('USDC', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');
const envPath = new URL('../.env.local', import.meta.url);
let env = await Deno.readTextFile(envPath);
const directory = new URL('../.local/wallets/', import.meta.url);
await Deno.mkdir(directory, { recursive: true, mode: 0o700 });
for (
  const [id, prefix, price] of [
    ['speech.generate', 'SPEECH_GENERATE', '200000'],
    ['video.slideshow', 'VIDEO_SLIDESHOW', '100000'],
    ['video.compose', 'VIDEO_COMPOSE', '100000'],
    ['video.caption', 'VIDEO_CAPTION', '200000'],
  ]
) {
  const path = new URL(`${id}.testnet.json`, directory);
  let wallet: { network: string; publicKey: string; secretKey: string };
  try {
    wallet = JSON.parse(await Deno.readTextFile(path));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw new Error(`Cannot read ${id} wallet`);
    const keypair = Keypair.random();
    wallet = { network: 'stellar:testnet', publicKey: keypair.publicKey(), secretKey: keypair.secret() };
    await Deno.writeTextFile(path, JSON.stringify(wallet, null, 2) + '\n', { mode: 0o600, createNew: true });
  }
  await Deno.chmod(path, 0o600);
  const keypair = Keypair.fromSecret(wallet.secretKey);
  if (wallet.network !== 'stellar:testnet' || keypair.publicKey() !== wallet.publicKey) {
    throw new Error('Invalid local testnet wallet');
  }
  const existing = env.split('\n').find((line) => line.startsWith(`${prefix}_PAY_TO=`))?.split('=')[1];
  if (existing && existing !== wallet.publicKey) {
    throw new Error(`${id} recipient differs; refusing to rotate it`);
  }
  let account;
  try {
    account = await server.loadAccount(wallet.publicKey);
  } catch (error) {
    if (
      !(error instanceof Error) || !('response' in error) ||
      (error as { response: { status: number } }).response?.status !== 404
    ) throw new Error('Testnet account lookup failed');
    const funding = await fetch(`https://friendbot.stellar.org/?addr=${wallet.publicKey}`, {
      signal: AbortSignal.timeout(45000),
    });
    if (!funding.ok) throw new Error(`Friendbot failed for ${id}: HTTP ${funding.status}`);
    await funding.body?.cancel();
    account = await server.loadAccount(wallet.publicKey);
  }
  const trusted = account.balances.some((balance) =>
    'asset_code' in balance && balance.asset_code === usdc.code && balance.asset_issuer === usdc.issuer
  );
  if (!trusted) {
    const transaction = new TransactionBuilder(account, {
      fee: String(await server.fetchBaseFee()),
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.changeTrust({ asset: usdc, limit: '1000000' })).setTimeout(60).build();
    transaction.sign(keypair);
    await server.submitTransaction(transaction);
  }
  env = env.split('\n').filter((line) =>
    !line.startsWith(`${prefix}_PAY_TO=`) && !line.startsWith(`${prefix}_PRICE_ATOMIC=`)
  ).join('\n').trimEnd();
  env += `\n${prefix}_PAY_TO=${wallet.publicKey}\n${prefix}_PRICE_ATOMIC=${price}\n`;
  await Deno.writeTextFile(envPath, env, { mode: 0o600 });
  await Deno.chmod(envPath, 0o600);
  console.log(`${id}: testnet recipient and USDC trustline ready; secret retained locally.`);
}
