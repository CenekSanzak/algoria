import assert from 'node:assert/strict';
import { PGlite } from 'npm:@electric-sql/pglite@0.3.14';
import { Ajv2020 } from 'npm:ajv@8.20.0/dist/2020.js';
import { normalizeInput, PHONE_SERVICE } from './catalog.ts';
import { parseContacts, type PhoneConfig } from './config.ts';
import {
  type CallPatch,
  type CallRow,
  CallSession,
  PhoneCalls,
  type PhoneDependencies,
  signJob,
  Twilio,
  TwilioError,
} from './phone.ts';
import { jobSchemaFor } from './services.ts';
import type { ClaimResult, CompletionClaim, Job } from './store.ts';

const id = '00000000-0000-4000-8000-000000000001';
const CONFIG: PhoneConfig = {
  accountSid: 'AC00000000000000000000000000000000',
  authToken: 'test-auth-token',
  from: '+15550000000',
  openaiKey: 'sk-test',
  realtimeModel: 'gpt-realtime-mini',
  voice: 'marin',
  contacts: { berkin: '+15550000001' },
};

async function harness() {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
  for (
    const migration of [
      '202609180001_platform',
      '202609180002_speech_service',
      '202609190001_social_video',
      '202609200001_phone_call',
    ]
  ) await db.exec(await Deno.readTextFile(new URL(`../../migrations/${migration}.sql`, import.meta.url)));
  async function rpc<T>(name: string, args: unknown[] = []): Promise<T> {
    return (await db.query<{ r: T }>(
      `select public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) as r`,
      args,
    )).rows[0].r;
  }
  const get = async (): Promise<Job> =>
    (await db.query<Job>('select * from public.jobs where id=$1', [id])).rows[0];
  const store: PhoneDependencies['store'] = {
    get: async () => await get(),
    claimSubmission: (id) => rpc<ClaimResult>('platform_claim_submission', [id]),
    setSubmitted: (id, provider) => rpc<Job>('platform_set_submitted', [id, provider]),
    failJob: (id, code, message) => rpc<Job>('platform_fail_job', [id, code, message]),
    markRunning: (id) => rpc<Job>('platform_mark_running', [id]),
    claimCompletion: (id) => rpc<CompletionClaim>('platform_claim_completion', [id]),
    complete: (id, lease, output) => rpc<Job>('platform_complete_job', [id, lease, output]),
    releaseCompletion: (id, lease) => rpc<Job>('platform_release_completion', [id, lease]),
  };
  const calls: PhoneDependencies['calls'] = {
    get: async (jobId) =>
      (await db.query<CallRow>('select * from public.phone_calls where job_id=$1', [jobId])).rows[0] ?? null,
    create: async (jobId) => {
      await db.query('insert into public.phone_calls(job_id) values ($1) on conflict do nothing', [jobId]);
    },
    update: async (jobId, patch: CallPatch) => {
      const keys = Object.keys(patch) as (keyof CallPatch)[];
      await db.query(
        `update public.phone_calls set ${
          keys.map((key, i) => `${key}=$${i + 2}`).join(',')
        }, updated_at=now() where job_id=$1`,
        [jobId, ...keys.map((key) => key === 'transcript' ? JSON.stringify(patch[key]) : patch[key])],
      );
    },
  };
  const placed: { to: string; twiml: string; statusCallback: string }[] = [];
  const hungUp: string[] = [];
  let twilioMode: 'ok' | 'reject' | 'down' = 'ok';
  const summaries: unknown[] = [];
  const phone = new PhoneCalls({
    config: CONFIG,
    store,
    calls,
    baseUrl: 'https://api.example/functions/v1/api',
    twilio: {
      placeCall: (options) => {
        placed.push(options);
        if (twilioMode === 'reject') return Promise.reject(new TwilioError('Unverified [number]', true));
        if (twilioMode === 'down') {
          return Promise.reject(new TwilioError('Twilio could not be reached.', false));
        }
        return Promise.resolve('CA123');
      },
      hangup: (sid) => {
        hungUp.push(sid);
        return Promise.resolve();
      },
    },
    summarize: (input, transcript) => {
      summaries.push({ input, transcript });
      return Promise.resolve({ summary: 'Berkin is ready for the demo.', goal_achieved: true });
    },
  });
  const input = normalizeInput(PHONE_SERVICE, PHONE_SERVICE.exampleInput);
  await rpc('platform_create_job', [{
    id,
    service_id: 'phone.call',
    service_version: '1',
    input,
    input_hash: 'a'.repeat(64),
    recovery_token_hash: 'b'.repeat(64),
    requirements: {},
    resource_url: 'https://api.example/phone.call',
    expires_at: new Date(Date.now() + 600000).toISOString(),
  }]);
  async function pay() {
    await rpc('platform_claim_payment', [id, 'fingerprint', 'GPAYER', {}]);
    await rpc('platform_finish_payment', [id, 'success', { success: true }]);
  }
  return {
    db,
    get,
    pay,
    phone,
    calls,
    store,
    placed,
    hungUp,
    summaries,
    setTwilio: (mode: typeof twilioMode) => twilioMode = mode,
  };
}

Deno.test('phone input and contacts accept only approved names, never raw numbers', () => {
  assert.deepEqual(parseContacts('{"Berkin":"+905551112233"}'), { berkin: '+905551112233' });
  assert.throws(() => parseContacts('{"berkin":"05551112233"}'));
  assert.throws(() => parseContacts('[]'));
  assert.deepEqual(normalizeInput(PHONE_SERVICE, { contact: ' Berkin ', goal: ' Say hi ' }), {
    contact: 'berkin',
    goal: 'Say hi',
    on_behalf_of: 'an Algoria user',
  });
  assert.throws(() => normalizeInput(PHONE_SERVICE, { contact: '+905551112233', goal: 'x' }));
  assert.throws(() => normalizeInput(PHONE_SERVICE, { contact: 'berkin', goal: '' }));
  assert.throws(() => normalizeInput(PHONE_SERVICE, { contact: 'berkin', goal: 'x', to: '+1' }));
});

Deno.test('phone call: unpaid never dials; paid dials once; callbacks finish with transcript and summary', async () => {
  const h = await harness();
  try {
    assert.throws(() => h.phone.validate({ contact: 'stranger', goal: 'x', on_behalf_of: 'y' }), /approved/);
    await h.phone.start(await h.get());
    assert.equal(h.placed.length, 0);
    await h.pay();
    let job = await h.phone.start(await h.get());
    assert.equal(job.status, 'queued');
    assert.equal(job.provider_request_id, 'CA123');
    assert.equal(h.placed.length, 1);
    const token = await signJob(CONFIG.authToken, id);
    assert.equal(h.placed[0].to, '+15550000001');
    assert.match(h.placed[0].twiml, /<Stream url="wss:\/\/api\.example\/functions\/v1\/api\/phone\/stream">/);
    assert.ok(h.placed[0].twiml.includes(`<Parameter name="token" value="${token}"/>`));
    assert.equal(
      h.placed[0].statusCallback,
      `https://api.example/functions/v1/api/webhooks/twilio/${id}?token=${token}`,
    );
    await h.phone.start(await h.get());
    assert.equal(h.placed.length, 1, 'a submitted call is never redialed');

    await assert.rejects(
      h.phone.statusCallback(id, 'wrong', new URLSearchParams({ CallStatus: 'completed' })),
    );
    job = (await h.phone.statusCallback(id, token, new URLSearchParams({ CallStatus: 'in-progress' })))!;
    assert.equal(job.status, 'running');

    await h.calls.update(id, {
      transcript: [
        { speaker: 'agent', text: 'Hi Berkin, I am an AI assistant calling on behalf of Dogukan.' },
        { speaker: 'contact', text: 'Yes, I am ready.' },
        { speaker: 'contact', text: '' },
      ],
      ended_at: new Date().toISOString(),
    });
    job = (await h.phone.statusCallback(
      id,
      token,
      new URLSearchParams({ CallStatus: 'completed', CallDuration: '42' }),
    ))!;
    assert.equal(job.status, 'succeeded');
    const output = job.output as { call: Record<string, unknown> };
    assert.deepEqual(output.call, {
      contact: 'berkin',
      status: 'completed',
      duration_seconds: 42,
      summary: 'Berkin is ready for the demo.',
      goal_achieved: true,
      transcript: [
        { speaker: 'agent', text: 'Hi Berkin, I am an AI assistant calling on behalf of Dogukan.' },
        { speaker: 'contact', text: 'Yes, I am ready.' },
      ],
    });
    assert.equal(JSON.stringify(output).includes('+1555'), false, 'numbers stay out of results');
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const validate = ajv.compile(jobSchemaFor(PHONE_SERVICE));
    assert.ok(
      validate({
        job_id: id,
        service_id: 'phone.call',
        service_version: '1',
        status: 'succeeded',
        status_url: `https://api.example/v1/jobs/${id}`,
        payment: { success: true, network: 'stellar:testnet', transaction: 'b'.repeat(64) },
        output,
        error: null,
      }),
      JSON.stringify(validate.errors),
    );
    assert.equal(h.summaries.length, 1);
    await h.phone.advance(await h.get());
    assert.equal(h.summaries.length, 1, 'a finished job is not summarized twice');
  } finally {
    await h.db.close();
  }
});

Deno.test('phone call: unanswered, rejected and unreachable Twilio outcomes', async () => {
  const unanswered = await harness();
  try {
    await unanswered.pay();
    await unanswered.phone.start(await unanswered.get());
    const token = await signJob(CONFIG.authToken, id);
    const job =
      (await unanswered.phone.statusCallback(id, token, new URLSearchParams({ CallStatus: 'no-answer' })))!;
    assert.equal(job.status, 'failed');
    assert.equal((job.error as { code: string }).code, 'call-not-connected');
  } finally {
    await unanswered.db.close();
  }
  const rejected = await harness();
  try {
    rejected.setTwilio('reject');
    await rejected.pay();
    const job = await rejected.phone.start(await rejected.get());
    assert.equal(job.status, 'failed');
    assert.deepEqual(job.error, { code: 'call-rejected', message: 'Unverified [number]' });
  } finally {
    await rejected.db.close();
  }
  const down = await harness();
  try {
    down.setTwilio('down');
    await down.pay();
    const job = await down.phone.start(await down.get());
    assert.equal(
      job.status,
      'submitting',
      'an unknown dial outcome is kept for reconciliation, not redialed',
    );
    await down.phone.start(await down.get());
    assert.equal(down.placed.length, 1);
  } finally {
    await down.db.close();
  }
});

Deno.test('Twilio client redacts numbers from rejection messages and sends a time limit', async () => {
  const requests: { url: string; body: URLSearchParams }[] = [];
  const twilio = new Twilio(CONFIG, (url, init) => {
    requests.push({ url: String(url), body: init!.body as URLSearchParams });
    return Promise.resolve(
      Response.json({ message: 'The number +905551112233 is unverified.' }, { status: 400 }),
    );
  });
  await assert.rejects(
    twilio.placeCall({ to: '+905551112233', twiml: '<Response/>', statusCallback: 'https://x' }),
    (e: TwilioError) => e.rejected && e.message === 'The number [number] is unverified.',
  );
  assert.equal(requests[0].body.get('TimeLimit'), '100');
  assert.deepEqual(requests[0].body.getAll('StatusCallbackEvent'), [
    'initiated',
    'ringing',
    'answered',
    'completed',
  ]);
});

class FakeSocket {
  static OPEN = 1;
  readyState = 1;
  // deno-lint-ignore no-explicit-any -- recorded socket JSON
  sent: Record<string, any>[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

Deno.test('voice bridge relays mu-law audio, keeps transcript order, and hangs up after goodbye plays', async () => {
  const h = await harness();
  try {
    await h.pay();
    await h.phone.start(await h.get());
    const twilio = new FakeSocket();
    let openai!: FakeSocket;
    const opened: { url: string; protocols: string[] }[] = [];
    class Realtime extends FakeSocket {
      constructor(url: string, protocols: string[]) {
        super();
        opened.push({ url, protocols });
        openai = this;
      }
    }
    const session = new CallSession(twilio as unknown as WebSocket, {
      config: CONFIG,
      store: h.store,
      calls: h.calls,
      twilio: {
        placeCall: () => Promise.resolve(''),
        hangup: (sid) => (h.hungUp.push(sid), Promise.resolve()),
      },
      baseUrl: 'https://api.example',
      summarize: () => Promise.reject(new Error('unused')),
      realtime: Realtime as unknown as PhoneDependencies['realtime'],
    });
    session.listen();
    const token = await signJob(CONFIG.authToken, id);
    twilio.receive({ event: 'connected' });
    twilio.receive({
      event: 'start',
      start: { streamSid: 'MZ1', callSid: 'CA123', customParameters: { job: id, token } },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await h.get()).status, 'running');
    assert.equal(opened[0].url, 'wss://api.openai.com/v1/realtime?model=gpt-realtime-mini');
    assert.deepEqual(opened[0].protocols, ['realtime', 'openai-insecure-api-key.sk-test']);
    openai.onopen!();
    const update = openai.sent[0];
    assert.equal(update.type, 'session.update');
    assert.equal(update.session.audio.input.format.type, 'audio/pcmu');
    assert.equal(update.session.audio.output.format.type, 'audio/pcmu');
    assert.match(update.session.instructions, /on behalf of Dogukan/);
    assert.equal(openai.sent.at(-1)!.type, 'response.create', 'the assistant speaks first');

    twilio.receive({ event: 'media', media: { payload: 'AAAA' } });
    assert.deepEqual(openai.sent.at(-1), { type: 'input_audio_buffer.append', audio: 'AAAA' });
    openai.receive({ type: 'response.output_audio.delta', delta: 'BBBB' });
    assert.deepEqual(twilio.sent.at(-1), { event: 'media', media: { payload: 'BBBB' }, streamSid: 'MZ1' });
    openai.receive({ type: 'response.output_audio_transcript.done', transcript: 'Hi, AI assistant here.' });
    openai.receive({ type: 'input_audio_buffer.speech_started' });
    assert.deepEqual(twilio.sent.at(-1), { event: 'clear', streamSid: 'MZ1' });
    openai.receive({ type: 'input_audio_buffer.committed', item_id: 'item_1' });
    openai.receive({ type: 'response.output_audio_transcript.done', transcript: 'Great, see you at 3.' });
    // The callee's transcription arrives late but keeps its place before the reply.
    openai.receive({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item_1',
      transcript: 'Yes, ready.',
    });
    openai.receive({ type: 'response.function_call_arguments.done', name: 'end_call' });
    openai.receive({ type: 'response.done' });
    assert.deepEqual(twilio.sent.at(-1), { event: 'mark', mark: { name: 'goodbye' }, streamSid: 'MZ1' });
    twilio.receive({ event: 'mark', mark: { name: 'goodbye' } });
    await session.done;
    assert.deepEqual(h.hungUp, ['CA123']);
    const row = (await h.calls.get(id))!;
    assert.ok(row.ended_at);
    assert.deepEqual(row.transcript, [
      { speaker: 'agent', text: 'Hi, AI assistant here.' },
      { speaker: 'contact', text: 'Yes, ready.' },
      { speaker: 'agent', text: 'Great, see you at 3.' },
    ]);
  } finally {
    await h.db.close();
  }
});

Deno.test('voice bridge refuses a stream with a forged job token', async () => {
  const h = await harness();
  try {
    await h.pay();
    await h.phone.start(await h.get());
    const twilio = new FakeSocket();
    const session = new CallSession(twilio as unknown as WebSocket, {
      config: CONFIG,
      store: h.store,
      calls: h.calls,
      twilio: { placeCall: () => Promise.resolve(''), hangup: () => Promise.resolve() },
      baseUrl: 'https://api.example',
      summarize: () => Promise.reject(new Error('unused')),
      realtime: class {
        constructor() {
          throw new Error('must not connect to OpenAI');
        }
      } as unknown as PhoneDependencies['realtime'],
    });
    session.listen();
    twilio.receive({
      event: 'start',
      start: { streamSid: 'MZ1', callSid: 'CA123', customParameters: { job: id, token: 'forged' } },
    });
    await session.done;
    assert.equal(twilio.readyState, 3);
    assert.equal((await h.get()).status, 'queued');
  } finally {
    await h.db.close();
  }
});
