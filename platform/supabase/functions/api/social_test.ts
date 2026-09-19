import assert from 'node:assert/strict';
import { PGlite } from 'npm:@electric-sql/pglite@0.3.14';
import { pngDimensions, sceneDurations, SocialWorkflow } from './social.ts';
import { normalizeSocial } from './social-input.ts';
import { SOCIAL_SERVICE } from './catalog.ts';
import { type FalPollResult, FalSubmissionError, type FalTarget } from './fal.ts';
import type { CompletionClaim, Job } from './store.ts';
import type { SocialStep } from './social-store.ts';
import { uploadReference } from './references.ts';

function png(width = 576, height = 1024) {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set(new TextEncoder().encode('IHDR'), 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}
const id = '00000000-0000-4000-8000-000000000001';
async function harness(input = normalizeSocial(SOCIAL_SERVICE.exampleInput)) {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
  for (
    const migration of ['202609180001_platform', '202609180002_speech_service', '202609190001_social_video']
  ) await db.exec(await Deno.readTextFile(new URL(`../../migrations/${migration}.sql`, import.meta.url)));
  async function rpc<T>(name: string, args: unknown[] = []): Promise<T> {
    return (await db.query<{ r: T }>(
      `select public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) as r`,
      args,
    )).rows[0].r;
  }
  const get = async (): Promise<Job> =>
    (await db.query<Job>('select * from public.jobs where id=$1', [id])).rows[0];
  const steps = async (): Promise<SocialStep[]> =>
    (await db.query<SocialStep>('select * from public.social_steps where job_id=$1 order by name', [id]))
      .rows;
  const store = {
    get: async () => await get(),
    claimCompletion: (id: string) => rpc<CompletionClaim>('platform_claim_completion', [id]),
    releaseCompletion: (id: string, lease: string) => rpc<Job>('platform_release_completion', [id, lease]),
    complete: (id: string, lease: string, output: Record<string, unknown>) =>
      rpc<Job>('platform_complete_job', [id, lease, output]),
    failJob: (id: string, code: string, message: string) =>
      rpc<Job>('platform_fail_job', [id, code, message]),
  };
  const repository = {
    start: (id: string) => rpc<Job>('social_start', [id]),
    steps,
    write: (
      id: string,
      lease: string,
      name: string,
      state: string,
      provider?: string,
      output?: Record<string, unknown>,
    ) => rpc<boolean>('social_step_write', [id, lease, name, state, provider ?? null, output ?? null]),
    parent: async (provider: string) =>
      (await db.query<{ job_id: string }>('select job_id from public.social_steps where provider_id=$1', [
        provider,
      ])).rows[0]?.job_id,
    active: async () => [await get()],
    referencePath: () => Promise.resolve(true),
  };
  const calls: { input: Record<string, unknown>; target: FalTarget; id: string }[] = [];
  let mode: 'success' | 'uncertain' | 'reject' = 'success';
  let storageFails = false;
  let audioDuration = 12;
  let mediaDuration = 12;
  let waiting: Promise<void> | undefined;
  const workflow = new SocialWorkflow({
    store,
    repository,
    baseUrl: 'https://api.example',
    supabaseUrl: 'https://storage.example',
    fal: {
      submit: async (input, _webhook, target) => {
        const requestId = `request-${calls.length}`;
        calls.push({ input, target: target!, id: requestId });
        if (waiting) await waiting;
        if (mode !== 'success') {
          throw new FalSubmissionError('test', mode === 'reject' ? 'rejected' : 'uncertain');
        }
        return { requestId };
      },
      poll: (requestId): Promise<FalPollResult> => {
        const target = calls.find((c) => c.id === requestId)!.target;
        return Promise.resolve({
          status: 'succeeded',
          ...(target.output === 'images'
            ? { images: [{ url: 'https://fal.media/image.png', width: undefined, height: undefined }] }
            : target.output === 'audio'
            ? { audio: { url: 'https://fal.media/audio.wav' } }
            : { video: { url: 'https://fal.media/video.mp4' } }),
        });
      },
    },
    artifacts: {
      put: () => storageFails ? Promise.reject(new Error('storage unavailable')) : Promise.resolve(),
      signedUrl: (path) => Promise.resolve(`https://storage.example/${path}`),
    },
    downloadImage: () => Promise.resolve({ bytes: png(), contentType: 'image/png' }),
    downloadAudio: () =>
      Promise.resolve({ bytes: new Uint8Array(44), contentType: 'audio/wav', duration: audioDuration }),
    downloadVideo: () =>
      Promise.resolve({ bytes: new Uint8Array(64), contentType: 'video/mp4', duration: mediaDuration }),
  });
  await rpc('platform_create_job', [{
    id,
    service_id: 'video.social',
    service_version: '1',
    input,
    input_hash: 'a'.repeat(64),
    recovery_token_hash: 'b'.repeat(64),
    requirements: {},
    resource_url: 'https://api.example/video.social',
    expires_at: new Date(Date.now() + 600000).toISOString(),
  }]);
  async function pay() {
    await rpc('platform_claim_payment', [id, 'fingerprint', 'GPAYER', {}]);
    await rpc('platform_finish_payment', [id, 'success', { success: true }]);
  }
  return {
    db,
    rpc,
    get,
    steps,
    workflow,
    calls,
    pay,
    repository,
    setMode: (v: typeof mode) => mode = v,
    setStorage: (v: boolean) => storageFails = v,
    setAudio: (v: number) => audioDuration = v,
    setVideo: (v: number) => mediaDuration = v,
    setWait: (v: Promise<void>) => waiting = v,
  };
}

Deno.test('social workflow: five images plus speech parallel, one reservation, timed render and captions, retry-safe', async () => {
  const h = await harness();
  try {
    await h.workflow.start(await h.get());
    assert.equal(h.calls.length, 0); // An unpaid plan cannot generate anything.
    await h.pay();
    let release!: () => void;
    h.setWait(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const starting = h.workflow.start(await h.get());
    for (let i = 0; i < 200 && h.calls.length < 6; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(h.calls.length, 6); // Every provider submission starts before any can finish.
    release();
    await starting;
    await Promise.all([h.workflow.advance(await h.get()), h.workflow.advance(await h.get())]);
    assert.equal(h.calls.length, 7);
    const slideshow = h.calls[6];
    assert.match(slideshow.target.model, /images-to-video/);
    assert.equal((slideshow.input.images as { frames: number }[]).reduce((n, i) => n + i.frames, 0), 288);
    await h.workflow.advance(await h.get());
    assert.match(h.calls[7].target.model, /merge-audio-video/);
    await h.workflow.advance(await h.get());
    assert.match(h.calls[8].target.model, /auto-subtitle/);
    await h.workflow.advance(await h.get());
    assert.equal((await h.get()).status, 'succeeded');
    assert.equal((await h.get()).output?.duration, 12);
    assert.equal((await h.get()).output?.width, 576);
    await h.workflow.start(await h.get());
    await h.workflow.advance(await h.get());
    assert.equal(h.calls.length, 9);
    const progress = await h.workflow.progress(await h.get());
    assert.equal(progress.completed, 9);
    assert.equal(progress.total, 9);
    assert.equal((await h.rpc<{ totalUsed: number }>('platform_capacity')).totalUsed, 1);
    await assert.rejects(h.db.exec('set role anon; select * from public.social_steps'), /permission denied/);
  } finally {
    await h.db.close();
  }
});
Deno.test('social sends independent still-image scenes to fal and keeps campaign/audio instructions separate', async () => {
  for (const useReferences of [false, true]) {
    const input = normalizeSocial({
      ...SOCIAL_SERVICE.exampleInput,
      brief:
        'Make a 20-second sponsored Veyro Reel, five scenes, English Olivia voiceover, timed transitions and subtitles.',
      scenes: [
        'One photorealistic portrait of the woman from reference 1 wearing the lime-green woven fedora from reference 2, black-and-white chevron band, soft rooftop daylight.',
        'One still life of the lime-green woven fedora from reference 2 on a cream surface, black-and-white chevron band, soft daylight. No people.',
        'One photograph of the lime-green woven fedora against a cream backdrop, with the exact visible lettering "Veyro — Wear Your Color".',
      ],
      narration: 'Paid partnership with Veyro. Find your shade and wear your color.',
      references: useReferences
        ? [
          {
            url: `https://storage.example/storage/v1/object/sign/outputs/references/${id}/${
              'a'.repeat(64)
            }.jpg?token=test`,
            role: 'person',
          },
          {
            url: `https://storage.example/storage/v1/object/sign/outputs/references/${id}/${
              'b'.repeat(64)
            }.png?token=test`,
            role: 'product',
          },
        ]
        : [],
    });
    const h = await harness(input);
    try {
      await h.pay();
      await h.workflow.start(await h.get());
      const images = h.calls.filter((c) => c.target.output === 'images');
      assert.equal(images.length, 3);
      for (const [i, call] of images.entries()) {
        const prompt = String(call.input.prompt);
        assert.ok(prompt.includes(input.scenes[i]));
        for (const other of input.scenes.filter((_, n) => n !== i)) assert.ok(!prompt.includes(other));
        assert.ok(!prompt.includes(input.brief));
        assert.ok(!prompt.includes(input.narration));
        assert.doesNotMatch(prompt, /20-second|Reel|voiceover|Olivia|transitions|subtitles/);
        assert.doesNotMatch(prompt, /no added text|any referenced person's identity/i);
        assert.equal(call.input.aspect_ratio, '9:16');
        assert.equal(call.input.num_images, 1);
        assert.equal(
          call.target.model,
          useReferences ? 'fal-ai/nano-banana-2/edit' : 'google/nano-banana-2-lite',
        );
        assert.equal((call.input.image_urls as string[] | undefined)?.length ?? 0, useReferences ? 2 : 0);
      }
      const speech = h.calls.find((c) => c.target.output === 'audio')!;
      assert.equal(speech.input.text, input.narration);
      assert.equal(speech.input.voice, input.voice);
      assert.equal((await h.get()).input.brief, input.brief); // Keep the approved plan for recovery.
    } finally {
      await h.db.close();
    }
  }
});
Deno.test('social uncertain submissions retain capacity and never regenerate or settle again', async () => {
  const h = await harness();
  try {
    await h.pay();
    h.setMode('uncertain');
    await h.workflow.start(await h.get());
    assert.equal(h.calls.length, 6);
    h.setMode('success');
    await h.workflow.advance(await h.get());
    await h.workflow.sweep();
    assert.equal(h.calls.length, 6);
    assert.equal((await h.workflow.progress(await h.get())).needs_reconciliation, true);
    assert.equal((await h.rpc<{ active: number }>('platform_capacity')).active, 1);
  } finally {
    await h.db.close();
  }
});
Deno.test('social recovers stored provider IDs after storage failure and rejects oversized narration', async () => {
  const h = await harness();
  try {
    await h.pay();
    await h.workflow.start(await h.get());
    h.setStorage(true);
    await h.workflow.advance(await h.get());
    assert.equal(h.calls.length, 6);
    h.setStorage(false);
    h.setAudio(31);
    await h.workflow.advance(await h.get());
    assert.equal((await h.get()).status, 'failed');
    assert.equal(h.calls.length, 6);
  } finally {
    await h.db.close();
  }
});
Deno.test('social lease fences stale writers and killed dispatches require reconciliation', async () => {
  const h = await harness();
  try {
    await h.pay();
    await h.repository.start(id);
    const lease = await h.rpc<CompletionClaim>('platform_claim_completion', [id]);
    await h.repository.write(id, lease.leaseToken!, 'image-0', 'submitting');
    await h.db.query("update public.jobs set completion_lease_until=now()-interval '1 second' where id=$1", [
      id,
    ]);
    await assert.rejects(
      h.repository.write(id, lease.leaseToken!, 'image-0', 'queued', 'lost'),
      /lease-lost/,
    );
    await h.workflow.advance(await h.get());
    assert.equal(h.calls.length, 0);
    assert.equal((await h.workflow.progress(await h.get())).needs_reconciliation, true);
  } finally {
    await h.db.close();
  }
});
Deno.test('social input accepts product-only references, defaults female voice and refuses unsupported fields', () => {
  const input = normalizeSocial({
    ...SOCIAL_SERVICE.exampleInput,
    references: [{ url: 'https://example.com/photo.png', role: 'product' }],
  });
  assert.equal(input.voice, 'Olivia (en)');
  assert.equal(input.references.length, 1);
  assert.throws(() => normalizeSocial({ ...input, scenes: Array(6).fill('test') }));
  assert.throws(() => normalizeSocial({ ...input, narration: Array(66).fill('word').join(' ') }));
  assert.throws(() => normalizeSocial({ ...input, model: 'arbitrary' }));
  for (const duration of [0.1, 1, 12.345, 29.79]) {
    const sum = sceneDurations(duration, 5).reduce((a, b) => a + b, 0);
    assert.ok(sum + 0.003 >= duration);
    assert.ok(sum <= 30);
  }
  assert.throws(() => sceneDurations(30, 5));
});
Deno.test('reference uploads validate bytes, bind content to recovery identity and stay private', async () => {
  const h = await harness();
  try {
    const repository = {
      reserveReference: (id: string, token: string, content: string, path: string) =>
        h.rpc('social_reference_reserve', [id, token, content, path]),
    };
    const paths: string[] = [];
    const artifacts = {
      put: (path: string) => {
        paths.push(path);
        return Promise.resolve();
      },
      signedUrl: (path: string) => Promise.resolve(`https://private.example/${path}?signed=true`),
    };
    const bytes = new Uint8Array(24);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
    const request = (token = 'a'.repeat(43), body = bytes) =>
      new Request('https://api.example/v1/references/' + id, {
        method: 'POST',
        headers: { 'content-type': 'image/png', 'X-Recovery-Token': token },
        body,
      });
    await uploadReference(request(), id, repository, artifacts);
    await uploadReference(request(), id, repository, artifacts);
    assert.equal(paths[0], paths[1]);
    await assert.rejects(
      uploadReference(request('b'.repeat(43)), id, repository, artifacts),
      /reference-not-found/,
    );
    const changed = bytes.slice();
    changed[23] = 1;
    await assert.rejects(
      uploadReference(request('a'.repeat(43), changed), id, repository, artifacts),
      /reference-conflict/,
    );
    await assert.rejects(
      uploadReference(request('a'.repeat(43), new Uint8Array(24)), id, repository, artifacts),
      /invalid-reference-image/,
    );
    await assert.rejects(
      h.db.exec('set role anon; select * from public.social_references'),
      /permission denied/,
    );
  } finally {
    await h.db.close();
  }
});

Deno.test('social image size comes from PNG bytes when provider omits metadata', () => {
  assert.deepEqual(pngDimensions(png()), { width: 576, height: 1024 });
  assert.equal(pngDimensions(png(0, 1024)), undefined);
  assert.equal(pngDimensions(png(4096, 8192)), undefined);
  assert.equal(pngDimensions(new Uint8Array(33)), undefined);
});
