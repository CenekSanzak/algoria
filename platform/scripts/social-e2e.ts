import { signPaymentChallenge } from './payment-client.ts';
import type { PaymentRequired } from '../supabase/functions/api/payments.ts';
import { mediaDuration } from '../supabase/functions/api/fal.ts';
import { normalizeSocial, type SocialInput } from '../supabase/functions/api/social-input.ts';

// One bounded composite purchase. Never recreate or repay a dispatched job.
if (!Deno.args.includes('--live')) {
  throw new Error('Use --live: consumes real fal capacity and 0.11 test USDC.');
}
const option = (name: string) => Deno.args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
if (Deno.args.some((a) => a !== '--live' && !/^--(resume|input|reference)=.+$/.test(a))) {
  throw new Error('Unknown argument');
}
const base = `${Deno.env.get('SUPABASE_URL')}/functions/v1/api`;
if (base !== 'https://vqqbvydiehuwdzbgvmun.supabase.co/functions/v1/api') {
  throw new Error('Unexpected target');
}
const token = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+', '-').replaceAll(
    '/',
    '_',
  ).replaceAll('=', '');
type State = {
  id: string;
  token: string;
  input: SocialInput;
  dispatched?: boolean;
  reference?: { id: string; token: string; path?: string };
  result?: Record<string, unknown>;
};
const resume = option('resume');
if (resume && (option('input') || option('reference'))) {
  throw new Error('Resume preserves the original input and reference.');
}
const path = resume ?? `.local/social-e2e-${crypto.randomUUID()}.json`;
if (!/^\.local\/social-e2e-[0-9a-f-]{36}\.json$/.test(path)) throw new Error('Invalid state path');
if (!resume && !option('input')) throw new Error('Supply --input=approved-plan.json');
const state: State = resume ? JSON.parse(await Deno.readTextFile(path)) : {
  id: crypto.randomUUID(),
  token: token(),
  input: normalizeSocial(JSON.parse(await Deno.readTextFile(option('input')!))),
};
const save = () => Deno.writeTextFile(path, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
await save();
console.log(`Saved ${path}; use --resume=${path} after interruption.`);
async function call(url: string, init?: RequestInit) {
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(115000) });
  const body = await response.json();
  return { response, body };
}
if (!resume && option('reference')) {
  state.reference = { id: crypto.randomUUID(), token: token(), path: option('reference') };
  await save();
}
if (state.reference && state.input.references.length === 0) {
  if (state.dispatched || !state.reference.path) {
    throw new Error('Missing reference input; do not execute a changed plan.');
  }
  const bytes = await Deno.readFile(state.reference.path);
  const upload = await call(`${base}/v1/references/${state.reference.id}`, {
    method: 'POST',
    headers: { 'content-type': 'image/png', 'X-Recovery-Token': state.reference.token },
    body: bytes,
  });
  if (!upload.response.ok) throw new Error(`Upload failed: ${upload.response.status}`);
  state.input.references = [{ url: upload.body.url, role: 'product' }];
  await save();
}
const headers = {
  'content-type': 'application/json',
  'Idempotency-Key': state.id,
  'X-Recovery-Token': state.token,
};
let result;
if (!state.dispatched) {
  result = await call(`${base}/v1/services/video.social?mode=async`, {
    method: 'POST',
    headers,
    body: JSON.stringify(state.input),
  });
  if (result.response.status !== 402 || result.body.accepts?.[0]?.amount !== '1100000') {
    throw new Error(`Expected 0.11 test USDC quote; HTTP ${result.response.status}`);
  }
  const signature = await signPaymentChallenge(
    result.body as PaymentRequired,
    '.local/wallets/test-payer.testnet.json',
    Deno.env.get('VIDEO_SOCIAL_PAY_TO')!,
    '1100000',
  );
  state.dispatched = true;
  await save();
  result = await call(`${base}/v1/services/video.social?mode=async`, {
    method: 'POST',
    headers: { ...headers, 'PAYMENT-SIGNATURE': signature },
    body: JSON.stringify(state.input),
  });
} else {result = await call(`${base}/v1/jobs/${state.id}`, {
    headers: { authorization: `Bearer ${state.token}` },
  });}
for (let attempt = 0; attempt < 160; attempt++) {
  state.result = result.body;
  await save();
  console.log(JSON.stringify({ job: state.id, status: result.body.status, progress: result.body.progress }));
  if (result.body.status === 'succeeded') break;
  if (
    ![200, 202].includes(result.response.status) ||
    ['failed', 'payment-uncertain', 'submission-uncertain', 'awaiting_payment'].includes(result.body.status)
  ) {
    throw new Error(
      `Job needs attention: ${result.body.status ?? result.response.status}; use saved identity.`,
    );
  }
  if (result.body.status === 'paid') {
    result = await call(`${base}/v1/services/video.social?mode=async`, {
      method: 'POST',
      headers,
      body: JSON.stringify(state.input),
    });
  } else {
    await new Promise((r) => setTimeout(r, 3000));
    result = await call(`${base}/v1/jobs/${state.id}`, {
      headers: { authorization: `Bearer ${state.token}` },
    });
  }
}
if (result.body.status !== 'succeeded') throw new Error('Still running; resume saved state.');
if (result.body.payment?.success !== true) throw new Error('Missing payment receipt');
const video = result.body.output?.video;
const download = await fetch(video.url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
if (!download.ok) throw new Error('Video download failed');
const bytes = new Uint8Array(await download.arrayBuffer());
const duration = mediaDuration(bytes, 'video/mp4');
if (!duration || duration > 30.05 || video.width / video.height < 0.54 || video.width / video.height > 0.59) {
  throw new Error('Invalid video format/duration');
}
const output = path.replace('.json', '.mp4');
await Deno.writeFile(output, bytes, { mode: 0o600 });
// Terminal retries must preserve the receipt/output and create no new generation.
const retry = await call(`${base}/v1/services/video.social?mode=async`, {
  method: 'POST',
  headers,
  body: JSON.stringify(state.input),
});
if (
  retry.body.status !== 'succeeded' || retry.body.payment?.transaction !== result.body.payment.transaction
) throw new Error('Terminal retry mismatch');
console.log(
  JSON.stringify({
    output,
    duration,
    dimensions: [video.width, video.height],
    transaction: result.body.payment.transaction,
    charged_test_usdc: '0.11',
  }),
);
