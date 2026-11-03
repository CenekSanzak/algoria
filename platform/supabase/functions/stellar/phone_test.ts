import assert from 'node:assert/strict';
import { type CallPatch, CallSession, type SessionDependencies, signJob } from '../api/phone.ts';
import { CONFIG } from './testing.ts';

const JOB = '0192d3a4-7c1e-7b2a-9f00-3c5e8a1b2c3d';

class FakeSocket {
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  onopen?: () => void;
  onerror?: () => void;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

function session(callable: SessionDependencies['callable']) {
  const twilio = new FakeSocket();
  let openai!: FakeSocket;
  const optedOut: string[] = [];
  const patches: CallPatch[] = [];
  class Realtime extends FakeSocket {
    constructor() {
      super();
      openai = this;
    }
  }
  const call = new CallSession(twilio as unknown as WebSocket, {
    config: CONFIG.phone,
    calls: {
      note: () => Promise.resolve(),
      get: () => Promise.resolve(null),
      create: () => Promise.resolve(),
      update: (_id, patch) => (patches.push(patch), Promise.resolve()),
    },
    twilio: { hangup: () => Promise.resolve() },
    realtime: Realtime as unknown as SessionDependencies['realtime'],
    callable,
    started: () => Promise.resolve(),
    optOut: (jobId) => (optedOut.push(jobId), Promise.resolve()),
  });
  call.listen();
  return { call, twilio, openai: () => openai, optedOut, patches };
}

async function start(s: ReturnType<typeof session>) {
  s.twilio.receive({
    event: 'start',
    start: {
      streamSid: 'MZ1',
      callSid: `CA${'1'.repeat(32)}`,
      customParameters: { job: JOB, token: await signJob(CONFIG.phone.authToken, JOB) },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
}

Deno.test('the voice bridge refuses a job that may not stream', async () => {
  const s = session(() => Promise.resolve(null));
  await start(s);
  await s.call.done;
  assert.equal(s.twilio.readyState, 3);
});

Deno.test('the assistant knows who it calls, follows the safety rules and can record an opt-out', async () => {
  const s = session(() =>
    Promise.resolve({
      callee: 'Luna Bistro',
      goal: 'Confirm the table at 7.',
      on_behalf_of: 'Alex',
      language: 'tr',
    })
  );
  await start(s);
  const openai = s.openai();
  openai.onopen!();
  const update = openai.sent[0] as {
    session: {
      instructions: string;
      tools: { name: string }[];
      audio: { input: { transcription: { language: string } } };
    };
  };
  assert.match(
    update.session.instructions,
    /You are calling Luna Bistro\. Your goal: Confirm the table at 7\./,
  );
  assert.match(update.session.instructions, /Speak Turkish only/);
  assert.match(update.session.instructions, /never ask them to make a payment or a transfer/);
  assert.match(update.session.instructions, /call the opt_out tool/);
  assert.deepEqual(update.session.tools.map((tool) => tool.name), ['end_call', 'opt_out']);
  assert.equal(update.session.audio.input.transcription.language, 'tr');

  openai.receive({ type: 'response.function_call_arguments.done', name: 'opt_out', call_id: 'call_1' });
  assert.deepEqual(s.optedOut, [JOB]);
  assert.deepEqual(openai.sent.at(-1), {
    type: 'conversation.item.create',
    item: { type: 'function_call_output', call_id: 'call_1', output: '{"recorded":true}' },
  });
  // The assistant goes on to its goodbye once the tool's response is done.
  openai.receive({ type: 'response.done' });
  assert.deepEqual(openai.sent.at(-1), { type: 'response.create' });
  openai.receive({ type: 'response.function_call_arguments.done', name: 'end_call', call_id: 'call_2' });
  openai.receive({ type: 'response.done' });
  assert.deepEqual(s.twilio.sent.at(-1), { event: 'mark', mark: { name: 'goodbye' }, streamSid: 'MZ1' });
  s.twilio.receive({ event: 'mark', mark: { name: 'goodbye' } });
  await s.call.done;
  assert.ok(s.patches.some((patch) => patch.ended_at));
});
