import { signPaymentChallenge } from './payment-client.ts';
import type { PaymentRequired } from '../supabase/functions/api/payments.ts';

// Explicit live flag: this test spends 0.01 test USDC and generates ONE paid fal image.
const scenario = Deno.args[0];
if (!['sync', 'async', 'fallback'].includes(scenario) || !Deno.args.includes('--live')) {
  throw new Error('Usage: deno run -A --env-file=.env.local scripts/e2e.ts sync|async|fallback --live');
}
const base = Deno.env.get('ALGORIA_API_BASE_URL') || `${Deno.env.get('SUPABASE_URL')}/functions/v1/api`;
const recipient = Deno.env.get('IMAGE_GENERATE_PAY_TO');
if (!recipient || !base.startsWith('https://vqqbvydiehuwdzbgvmun.supabase.co/')) {
  throw new Error('Unexpected test target');
}
const id = crypto.randomUUID();
const recovery = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+', '-')
  .replaceAll('/', '_').replaceAll('=', '');
const input = {
  prompt: 'A small red sailboat on a calm turquoise sea at sunrise, clean watercolor illustration, no text.',
};
const query = scenario === 'fallback'
  ? 'mode=sync&wait_ms=0'
  : scenario === 'sync'
  ? 'mode=sync&wait_ms=60000'
  : 'mode=async';
const url = `${base}/v1/services/image.generate?${query}`;
const headers: Record<string, string> = {
  'content-type': 'application/json',
  'Idempotency-Key': id,
  'X-Recovery-Token': recovery,
};
const path = `.local/e2e-${scenario}-${id}.json`;
const receipt: Record<string, unknown> = {
  scenario,
  job_id: id,
  recovery_token: recovery,
  input,
  created_at: new Date().toISOString(),
};
await Deno.mkdir('.local', { recursive: true, mode: 0o700 });
async function save() {
  await Deno.writeTextFile(path, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
}
await save();
async function call(target: string, init?: RequestInit) {
  const result = await fetch(target, { ...init, signal: AbortSignal.timeout(90000) });
  const body = await result.json();
  return { result, body };
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const discovery = await call(`${base}/discovery/search?query=image`);
assert(discovery.result.ok && discovery.body.resources?.length === 1, 'Discovery failed');
const unpaid = await call(url, { method: 'POST', headers, body: JSON.stringify(input) });
assert(
  unpaid.result.status === 402 && unpaid.result.headers.has('payment-required'),
  `Expected unpaid402, got ${unpaid.result.status}`,
);
const challenge = unpaid.body as PaymentRequired;
assert(challenge.accepts[0].amount === '100000', 'Unexpected demo price');
console.log(`${scenario}: discovery and unpaid402 verified; job ${id}`);
headers['PAYMENT-SIGNATURE'] = await signPaymentChallenge(
  challenge,
  '.local/wallets/test-payer.testnet.json',
  recipient,
  '100000',
);
const paid = await call(url, { method: 'POST', headers, body: JSON.stringify(input) });
receipt.first_status = paid.result.status;
receipt.first_response = paid.body;
await save();
console.log(`${scenario}: paid HTTP ${paid.result.status}, status ${paid.body.status ?? paid.body.code}`);
assert([200, 202].includes(paid.result.status), `Paid request failed; inspect local receipt ${path}`);
assert(paid.body.payment?.success === true, `Settlement unconfirmed; inspect ${path}. Do not repay.`);
assert(paid.result.headers.has('payment-response'), 'Missing x402 receipt header');
if (scenario !== 'sync') assert(paid.result.status === 202, 'Expected asynchronous acceptance');
let current = paid.body;
for (let attempt = 0; current.status !== 'succeeded' && attempt < 45; attempt++) {
  assert(
    !['failed', 'payment-uncertain', 'submission-uncertain'].includes(current.status),
    `Job requires attention; inspect ${path}`,
  );
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const status = await call(`${base}/v1/jobs/${id}`, { headers: { authorization: `Bearer ${recovery}` } });
  assert(status.result.ok, `Status read failed HTTP ${status.result.status}`);
  current = status.body;
  console.log(`${scenario}: ${current.status}`);
}
receipt.final_response = current;
await save();
assert(
  current.status === 'succeeded' && current.output?.images?.length === 1,
  `Image unfinished; inspect ${path}`,
);
const image = await fetch(current.output.images[0].url, {
  method: 'HEAD',
  signal: AbortSignal.timeout(20000),
});
assert(image.ok && image.headers.get('content-type')?.startsWith('image/'), 'Stored image unavailable');
const denied = await call(`${base}/v1/jobs/${id}`);
assert(denied.result.status === 404, 'Recovery token authorization missing');
const repeated = await call(`${base}/v1/services/image.generate?mode=async`, {
  method: 'POST',
  headers,
  body: JSON.stringify(input),
});
assert(repeated.result.status === 200 && repeated.body.job_id === id, 'Idempotent retry failed');
assert(repeated.body.payment.transaction === current.payment.transaction, 'Retry changed settlement');
const conflict = await call(url, {
  method: 'POST',
  headers,
  body: JSON.stringify({ prompt: 'Different input must not create work.' }),
});
assert(conflict.result.status === 409, 'Input conflict not rejected');
console.log(
  JSON.stringify({
    passed: true,
    scenario,
    firstHttpStatus: paid.result.status,
    jobId: id,
    transaction: current.payment.transaction,
    receiptPath: path,
  }),
);
