import { signPaymentChallenge } from './payment-client.ts';
import type { PaymentRequired } from '../supabase/functions/api/payments.ts';
import { mediaDuration } from '../supabase/functions/api/fal.ts';

// Seven purchases: three images, narration, slideshow, composition and captions.
// A resume always uses the persisted request identities; it never starts over.
if (!Deno.args.includes('--live')) {
  throw new Error('Use --live; this demo incurs real fal charges and testnet payments.');
}
if (
  Deno.args.some((arg) => arg !== '--live' && !/^--(?:resume|reuse-media|reuse-images)=.+$/.test(arg)) ||
  new Set(Deno.args.map((arg) => arg.split('=')[0])).size !== Deno.args.length
) {
  throw new Error('Unknown or repeated option. Resume/reuse options require =.local/ad-demo-UUID.json.');
}
const base = Deno.env.get('ALGORIA_API_BASE_URL') || `${Deno.env.get('SUPABASE_URL')}/functions/v1/api`;
if (base !== 'https://vqqbvydiehuwdzbgvmun.supabase.co/functions/v1/api') {
  throw new Error('Unexpected demo target');
}
const resume = Deno.args.find((arg) => arg.startsWith('--resume='))?.slice('--resume='.length);
if (resume && !/^\.local\/ad-demo-[0-9a-f-]{36}\.json$/.test(resume)) throw new Error('Invalid resume path');
const reuse = Deno.args.find((arg) => arg.startsWith('--reuse-media='))?.slice('--reuse-media='.length);
const reuseImages = Deno.args.find((arg) => arg.startsWith('--reuse-images='))?.slice(
  '--reuse-images='.length,
);
const reusePath = reuse ?? reuseImages;
if (
  reusePath && (!/^\.local\/ad-demo-[0-9a-f-]{36}\.json$/.test(reusePath) || resume || (reuse && reuseImages))
) {
  throw new Error('Use one valid --reuse-media or --reuse-images path for a new run, or --resume.');
}
const path = resume ?? `.local/ad-demo-${crypto.randomUUID()}.json`;
type Step = {
  service: string;
  input: Record<string, unknown>;
  id: string;
  token: string;
  result?: Record<string, unknown>;
};
type Run = { version: 2; created_at: string; steps: Record<string, Step>; output?: string };
const state: Run = resume
  ? JSON.parse(await Deno.readTextFile(path))
  : { version: 2, created_at: new Date().toISOString(), steps: {} };
if (state.version !== 2) {
  throw new Error('Legacy demo state: use --reuse-media to retain its images and speech.');
}
if (reusePath) {
  const previous = JSON.parse(await Deno.readTextFile(reusePath));
  const names = ['scene-1', 'scene-2', 'scene-3', ...(reuseImages ? [] : ['narration'])];
  for (const name of names) {
    const step = previous.steps?.[name];
    if (!step || step.result?.status !== 'succeeded') throw new Error(`Missing completed source: ${name}`);
    state.steps[name] = step;
  }
}
await Deno.mkdir('.local', { recursive: true, mode: 0o700 });
const save = () => Deno.writeTextFile(path, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
await save();
console.log(`Demo state saved at ${path}; resume with --resume=${path}`);
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function call(url: string, init?: RequestInit) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(90000) });
  const body = await response.json();
  return { response, body };
}
async function run(key: string, service: string, input: Record<string, unknown>) {
  if (!state.steps[key]) {
    const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll(
      '+',
      '-',
    ).replaceAll('/', '_').replaceAll('=', '');
    state.steps[key] = { service, input, id: crypto.randomUUID(), token };
    await save();
  }
  const step = state.steps[key];
  assert(step.service === service, 'Persisted service differs');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'Idempotency-Key': step.id,
    'X-Recovery-Token': step.token,
  };
  const url = `${base}/v1/services/${service}?mode=${service === 'speech.generate' ? 'sync' : 'async'}`;
  let result = await call(url, { method: 'POST', headers, body: JSON.stringify(step.input) });
  if (result.response.status === 402) {
    assert(result.body.accepts?.length === 1, 'Expected a complete unpaid offer');
    const prefix = service.replaceAll('.', '_').toUpperCase();
    const payTo = Deno.env.get(`${prefix}_PAY_TO`);
    const cap = Deno.env.get(`${prefix}_PRICE_ATOMIC`) ??
      (service === 'image.generate' ? '100000' : undefined);
    assert(payTo && cap, 'Missing pinned recipient or price');
    headers['PAYMENT-SIGNATURE'] = await signPaymentChallenge(
      result.body as PaymentRequired,
      '.local/wallets/test-payer.testnet.json',
      payTo,
      cap,
    );
    result = await call(url, { method: 'POST', headers, body: JSON.stringify(step.input) });
  }
  step.result = result.body;
  await save();
  assert(
    [200, 202].includes(result.response.status),
    `${key}: HTTP ${result.response.status}; inspect saved state and resume the same identity.`,
  );
  for (let attempt = 0; result.body.status !== 'succeeded' && attempt < 90; attempt++) {
    assert(
      !['failed', 'payment-uncertain', 'submission-uncertain'].includes(result.body.status),
      `${key}: ${result.body.status}; do not pay again.`,
    );
    if (attempt % 10 === 0) console.log(`${key}: ${result.body.status}`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    result = await call(`${base}/v1/jobs/${step.id}`, { headers: { authorization: `Bearer ${step.token}` } });
    step.result = result.body;
    await save();
  }
  assert(
    result.body.status === 'succeeded' && result.body.payment?.success,
    `${key}: incomplete; resume the saved state.`,
  );
  const denied = await call(`${base}/v1/jobs/${step.id}`);
  assert(denied.response.status === 404, 'Output must require recovery authorization');
  const repeat = await call(url, {
    method: 'POST',
    headers: { ...headers, 'PAYMENT-SIGNATURE': '' },
    body: JSON.stringify(step.input),
  });
  assert(
    repeat.response.status === 200 && repeat.body.payment.transaction === result.body.payment.transaction,
    'Same-job receipt recovery failed',
  );
  console.log(`${key}: succeeded; ${service}; job ${step.id}`);
  return result.body.output;
}

const discovery = await call(`${base}/discovery/resources`);
assert(discovery.response.ok && discovery.body.resources.length === 5, 'Five services must be discoverable');
assert(
  new Set(discovery.body.resources.map((item: { accepts: { payTo: string }[] }) => item.accepts[0].payTo))
    .size === 5,
  'Each service must have its own wallet',
);
const prompts = [
  'Premium editorial product photograph for a fictional reusable bottle brand Tide: a matte deep teal stainless steel water bottle with a simple silver cap, standing on pale sand with soft morning shadows and a calm sea behind it. Clean square composition, subtle coral accent, no text, no people.',
  'Premium editorial product photograph: the same matte deep teal stainless steel water bottle with a simple silver cap, in the side pocket of a cream canvas tote on a sunny city cafe bench. Warm natural light, subtle coral accent, clean square composition, no text, no people.',
  'Premium editorial product photograph: a matte deep teal stainless steel water bottle with a simple silver cap resting on a coastal trail rock, turquoise ocean in the distance, golden afternoon light. Clean square composition, subtle coral accent, no text, no people.',
];
const images = [];
for (const [index, prompt] of prompts.entries()) {
  images.push(await run(`scene-${index + 1}`, 'image.generate', { prompt }));
}
const speech = await run('narration', 'speech.generate', {
  text:
    'Meet Tide. The reusable bottle built for everyday adventures. Keep your water close, your bag light, and your routine simple. From your morning commute to the weekend trail, take a better habit with you. Refill, head out, and make every day count.',
  voice: 'Craig (en)',
});
const duration = Math.max(15, Math.ceil(speech.audio.duration + 0.1));
assert(
  Number.isFinite(duration) && duration <= 20 && speech.audio.duration >= 15,
  'Narration must fit the 15–20 second demo target; retain completed images with --reuse-images.',
);
const firstScene = Math.floor(duration * 1000 / 3) / 1000;
const slideshow = await run('slideshow', 'video.slideshow', {
  images: images.map((result, index) => ({
    url: result.images[0].url,
    duration_seconds: index === 2 ? Math.round((duration - 2 * firstScene) * 1000) / 1000 : firstScene,
  })),
});
assert(
  Math.abs(slideshow.video.duration - duration) <= 2 / 24 + 0.002,
  'Slideshow duration differs from the requested scene timing; inspect before buying composition.',
);
const composed = await run('composition', 'video.compose', {
  video_url: slideshow.video.url,
  audio_url: speech.audio.url,
});
const captioned = await run('captions', 'video.caption', { video_url: composed.video.url });
const response = await fetch(captioned.video.url, { signal: AbortSignal.timeout(45000) });
assert(response.ok && response.headers.get('content-type')?.startsWith('video/mp4'), 'Final MP4 unavailable');
const bytes = new Uint8Array(await response.arrayBuffer());
const actualDuration = mediaDuration(bytes, 'video/mp4');
assert(actualDuration && actualDuration >= 14.5 && actualDuration <= 20.5, 'Unexpected final duration');
const output = path.replace(/\.json$/, '.mp4');
await Deno.writeFile(output, bytes, { mode: 0o600 });
state.output = output;
await save();
console.log(
  JSON.stringify({
    passed: true,
    services: 5,
    jobs: Object.keys(state.steps).length,
    duration: actualDuration,
    output,
    receiptPath: path,
  }),
);
