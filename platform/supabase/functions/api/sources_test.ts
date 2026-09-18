import { deepEqual, equal, rejects } from 'node:assert/strict';
import { COMPOSE_SERVICE, SERVICES, SLIDESHOW_SERVICE } from './catalog.ts';
import { resolveSources } from './sources.ts';
import type { Job } from './store.ts';

const id = '00000000-0000-4000-8000-000000000001';
const path = `${id}/video.mp4`;
const url = `https://db.example.test/storage/v1/object/sign/outputs/${path}?token=original`;
const service = SERVICES.find((item) => item.id === 'video.caption')!;
function fixture() {
  const job = {
    id,
    service_id: 'video.compose',
    status: 'succeeded',
    output: { path, content_type: 'video/mp4', duration: 20, file_size: 1000 },
  } as unknown as Job;
  let signs = 0;
  const dependencies = {
    supabaseUrl: 'https://db.example.test',
    store: { get: () => Promise.resolve(job) },
    artifacts: {
      put: () => Promise.resolve(),
      signedUrl: (value: string) => {
        equal(value, path);
        signs++;
        return Promise.resolve(url.replace('original', 'renewed'));
      },
    },
  };
  return { job, dependencies, signs: () => signs };
}

Deno.test('source admission requires a valid signed capability, correct producer and exact stored path', async () => {
  const f = fixture();
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = () => {
    requests++;
    return Promise.resolve(new Response(null, { status: 403 }));
  };
  try {
    await rejects(
      resolveSources(service, { video_url: url }, f.dependencies, true),
      /Refresh the source job/,
    );
    equal(requests, 1);
    equal(f.signs(), 0);
    f.job.service_id = 'speech.generate';
    await rejects(resolveSources(service, { video_url: url }, f.dependencies, true), /expected type/);
    equal(requests, 1);
    f.job.service_id = 'video.compose';
    await rejects(
      resolveSources(service, { video_url: url.replace('video.mp4', 'other.mp4') }, f.dependencies, true),
      /expected type/,
    );
    equal(requests, 1);
    f.job.output!.duration = 40;
    await rejects(resolveSources(service, { video_url: url }, f.dependencies, true), /at most 30 seconds/);
    equal(requests, 1);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test('an admitted immutable source can be re-signed without rechecking an expired original URL', async () => {
  const f = fixture();
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = () => {
    requests++;
    return Promise.resolve(
      new Response(null, { headers: { 'content-type': 'video/mp4', 'content-length': '1000' } }),
    );
  };
  try {
    const input = { video_url: url };
    equal((await resolveSources(service, input, f.dependencies, true)).video_url, url);
    equal(f.signs(), 0);
    globalThis.fetch = () => {
      throw new Error('Expired source must not be fetched after admission');
    };
    const resolved = await resolveSources(service, input, f.dependencies, false);
    equal(resolved.video_url, url.replace('original', 'renewed'));
    equal(input.video_url, url);
    equal(requests, 1);
    equal(f.signs(), 1);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test('slideshow and composition enforce matching images and each authorized producer in the five-stage chain', async () => {
  const jobs = new Map<string, Job>();
  const add = (producer: string, file: string, metadata: Record<string, unknown>) => {
    const id = crypto.randomUUID();
    const path = `${id}/${file}`;
    const job = {
      id,
      service_id: producer,
      status: 'succeeded',
      output: { path, ...metadata },
    } as unknown as Job;
    jobs.set(id, job);
    return { job, url: `https://db.example.test/storage/v1/object/sign/outputs/${path}?token=admitted` };
  };
  const first = add('image.generate', 'image.png', { width: 1024, height: 1024 });
  const second = add('image.generate', 'image.png', { width: 1024, height: 1024 });
  const audio = add('speech.generate', 'audio.wav', { duration: 15 });
  const slideshow = add('video.slideshow', 'video.mp4', { duration: 20 });
  const composed = add('video.compose', 'video.mp4', { duration: 20 });
  const signedPaths: string[] = [];
  const dependencies = {
    supabaseUrl: 'https://db.example.test',
    store: { get: (id: string) => Promise.resolve(jobs.get(id) ?? null) },
    artifacts: {
      put: () => Promise.resolve(),
      signedUrl: (path: string) => {
        signedPaths.push(path);
        return Promise.resolve(
          `https://db.example.test/storage/v1/object/sign/outputs/${path}?token=renewed`,
        );
      },
    },
  };
  const images = {
    images: [{ url: first.url, duration_seconds: 10 }, { url: second.url, duration_seconds: 10 }],
  };
  const input = { video_url: slideshow.url, audio_url: audio.url };
  const original = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    equal(init?.method, 'HEAD');
    equal(init?.redirect, 'error');
    const type = String(url).includes('.wav?')
      ? 'audio/wav'
      : String(url).includes('.mp4?')
      ? 'video/mp4'
      : 'image/png';
    return Promise.resolve(
      new Response(null, { headers: { 'content-type': type, 'content-length': '1000' } }),
    );
  };
  try {
    deepEqual(await resolveSources(SLIDESHOW_SERVICE, images, dependencies, true), images);
    second.job.output!.width = 512;
    await rejects(resolveSources(SLIDESHOW_SERVICE, images, dependencies, true), /matching dimensions/);
    second.job.output!.width = 1024;
    deepEqual(await resolveSources(COMPOSE_SERVICE, input, dependencies, true), input);
    await rejects(
      resolveSources(COMPOSE_SERVICE, { ...input, video_url: composed.url }, dependencies, true),
      /expected type/,
    );
    await rejects(resolveSources(service, { video_url: slideshow.url }, dependencies, true), /expected type/);
    equal(signedPaths.length, 0);
    globalThis.fetch = () => {
      throw new Error('Previously admitted sources must only be re-signed');
    };
    deepEqual(await resolveSources(COMPOSE_SERVICE, input, dependencies, false), {
      video_url: slideshow.url.replace('admitted', 'renewed'),
      audio_url: audio.url.replace('admitted', 'renewed'),
    });
    deepEqual(signedPaths.sort(), [slideshow.job.output!.path, audio.job.output!.path].sort());
  } finally {
    globalThis.fetch = original;
  }
});
