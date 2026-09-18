import { strict as assert } from 'node:assert';
import {
  downloadAudio,
  downloadImage,
  downloadVideo,
  FAL_MODEL,
  FalProvider,
  FalSubmissionError,
  type FalTarget,
  mediaDuration,
  parseWebhook,
  verifyWebhook,
} from './fal.ts';

const requestId = '80e732af-660e-45cd-bd63-580e4f2a94cc';
const provider = () => new FalProvider('test-key-not-a-secret');
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const wav = new Uint8Array([82, 73, 70, 70, 36, 0, 0, 0, 87, 65, 86, 69, 102, 109, 116, 32]);
const mp3 = new Uint8Array([73, 68, 51, 4, 0, 0, 0, 0, 0, 0]);
const mp4 = new Uint8Array([
  0,
  0,
  0,
  20,
  102,
  116,
  121,
  112,
  105,
  115,
  111,
  109,
  0,
  0,
  0,
  0,
  109,
  112,
  52,
  50,
]);
const audioTarget: FalTarget = {
  model: 'fal-ai/inworld-tts',
  queuePath: 'fal-ai/inworld-tts',
  output: 'audio',
};
const videoTarget: FalTarget = {
  model: 'fal-ai/ffmpeg-api/merge-audio-video',
  queuePath: 'fal-ai/ffmpeg-api',
  output: 'video',
};

async function withFetch(
  handler: (url: URL, init?: RequestInit) => Response | Promise<Response>,
  run: () => Promise<void>,
) {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    return Promise.resolve(handler(url, init));
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test('fal submits exactly once to persisted queue with fixed model options', async () => {
  let count = 0;
  await withFetch((url, init) => {
    count++;
    assert.equal(url.origin, 'https://queue.fal.run');
    assert.equal(url.pathname, `/${FAL_MODEL}`);
    assert.equal(url.searchParams.get('fal_webhook'), 'https://example.com/webhooks/fal?job=one');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Key test-key-not-a-secret');
    assert.ok(init?.signal);
    assert.deepEqual(JSON.parse(String(init?.body)), {
      prompt: 'A blue bird',
      num_images: 1,
      aspect_ratio: '1:1',
      output_format: 'png',
      limit_generations: true,
      sync_mode: false,
    });
    return json({ request_id: requestId });
  }, async () => {
    assert.deepEqual(
      await provider().submit({ prompt: 'A blue bird' }, 'https://example.com/webhooks/fal?job=one'),
      { requestId },
    );
  });
  assert.equal(count, 1);
});

Deno.test('fal explicit targets submit provider input unchanged and poll the application queue path', async () => {
  for (const target of [audioTarget, videoTarget]) {
    const input = target.output === 'audio'
      ? { text: 'Hello world', voice: 'Craig (en)', sample_rate_hertz: 48000 }
      : { audio_url: 'https://fal.media/audio.wav', video_url: 'https://fal.media/video.mp4' };
    const file = {
      url: `https://v3b.fal.media/files/${target.output}`,
      content_type: target.output === 'audio' ? 'audio/wav' : 'video/mp4',
      file_size: 4096,
      duration: 1.5,
      width: 512,
      height: 256,
    };
    const calls: string[] = [];
    await withFetch((url, init) => {
      calls.push(url.pathname);
      assert.equal(url.origin, 'https://queue.fal.run');
      assert.equal(init?.redirect, 'error');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Key test-key-not-a-secret');
      if (init?.method === 'POST') {
        assert.equal(url.pathname, `/${target.model}`);
        assert.equal(url.searchParams.get('fal_webhook'), 'https://example.com/hook');
        assert.deepEqual(JSON.parse(String(init.body)), input);
        return json({ request_id: requestId, status_url: 'https://attacker.example/status' });
      }
      if (url.pathname.endsWith('/status')) {
        return json({ status: 'COMPLETED', response_url: 'https://attacker.example/result' });
      }
      return json({ [target.output]: file, images: [{ url: 'https://attacker.example/image' }] });
    }, async () => {
      assert.deepEqual(await provider().submit(input, 'https://example.com/hook', target), { requestId });
      assert.deepEqual(await provider().poll(requestId, undefined, target), {
        status: 'succeeded',
        [target.output]: file,
      });
    });
    assert.deepEqual(calls, [
      `/${target.model}`,
      `/${target.queuePath}/requests/${requestId}/status`,
      `/${target.queuePath}/requests/${requestId}`,
    ]);
  }
});

Deno.test('fal rejects target route injection before any authenticated request', async () => {
  await withFetch(() => {
    throw new Error('must not fetch invalid target');
  }, async () => {
    for (
      const path of [
        'https://attacker.example/model',
        '//attacker.example/model',
        'fal-ai/../private',
        'fal-ai/%2e%2e/private',
        'fal-ai/model?key=x',
        'fal-ai/model#x',
        'fal-ai/model/',
      ]
    ) {
      for (const field of ['model', 'queuePath'] as const) {
        const target = { ...audioTarget, [field]: path };
        await assert.rejects(
          () => provider().submit({ text: 'Hello' }, 'https://example.com/hook', target),
          (error: unknown) => error instanceof FalSubmissionError && error.outcome === 'rejected',
        );
        await assert.rejects(() => provider().poll(requestId, undefined, target), /Invalid fal target/);
      }
    }
  });
});

Deno.test('fal media polling rejects missing files, wrong result types and untrusted media URLs', async () => {
  for (const target of [audioTarget, videoTarget]) {
    for (
      const file of [null, [], {}, { url: 'https://127.0.0.1/admin' }, {
        url: 'https://v3.fal.media.evil.example/media',
      }, { url: 'https://storage.googleapis.com/other-bucket/media' }]
    ) {
      await withFetch(
        (url) =>
          url.pathname.endsWith('/status') ? json({ status: 'COMPLETED' }) : json({ [target.output]: file }),
        () => assert.rejects(() => provider().poll(requestId, undefined, target)),
      );
    }
    await withFetch(
      (url) =>
        url.pathname.endsWith('/status')
          ? json({ status: 'COMPLETED' })
          : json({ images: [{ url: 'https://fal.media/image.png' }] }),
      () => assert.rejects(() => provider().poll(requestId, undefined, target)),
    );
    await withFetch(
      (url) =>
        url.pathname.endsWith('/status')
          ? json({ status: 'COMPLETED' })
          : json({ error: 'private input', error_type: 'private input' }),
      async () =>
        assert.deepEqual(await provider().poll(requestId, undefined, target), {
          status: 'failed',
          error: 'fal generation failed',
        }),
    );
  }
});

Deno.test('fal media polling ignores nullable and invalid optional metadata', async () => {
  for (const target of [audioTarget, videoTarget]) {
    const file = {
      url: 'https://fal.media/output',
      content_type: null,
      file_size: -1,
      duration: -0.5,
      width: 1.2,
      height: Number.MAX_SAFE_INTEGER + 1,
    };
    await withFetch(
      (url) =>
        url.pathname.endsWith('/status') ? json({ status: 'COMPLETED' }) : json({ [target.output]: file }),
      async () =>
        assert.deepEqual(await provider().poll(requestId, undefined, target), {
          status: 'succeeded',
          [target.output]: { url: file.url },
        }),
    );
  }
});

Deno.test('fal composition reads only a trusted flat video_url and ignores thumbnail/result URLs', async () => {
  const target: FalTarget = { ...videoTarget, output: 'video_url' };
  const videoUrl = 'https://v3b.fal.media/files/composed.mp4';
  await withFetch(
    (url) =>
      url.pathname.endsWith('/status')
        ? json({ status: 'COMPLETED', response_url: 'https://attacker.example/result' })
        : json({ video_url: videoUrl, thumbnail_url: 'https://attacker.example/thumbnail', duration: 999 }),
    async () =>
      assert.deepEqual(await provider().poll(requestId, undefined, target), {
        status: 'succeeded',
        video: { url: videoUrl },
      }),
  );
  for (const value of [null, 'https://attacker.example/video', { url: videoUrl }]) {
    await withFetch(
      (url) => url.pathname.endsWith('/status') ? json({ status: 'COMPLETED' }) : json({ video_url: value }),
      () => assert.rejects(() => provider().poll(requestId, undefined, target)),
    );
  }
});

Deno.test('fal submission distinguishes rejection from uncertain acceptance without retries', async () => {
  for (const status of [400, 401, 402, 403, 422, 429, 408, 425, 500, 503]) {
    let count = 0;
    await withFetch(() => {
      count++;
      return json({ detail: 'private input' }, status);
    }, async () => {
      await assert.rejects(
        () => provider().submit({ prompt: 'A bird' }, 'https://example.com/hook'),
        (error: unknown) => {
          assert.ok(error instanceof FalSubmissionError);
          assert.equal(
            error.outcome,
            status < 500 && status !== 408 && status !== 425 ? 'rejected' : 'uncertain',
          );
          assert.ok(!error.message.includes('private input'));
          return true;
        },
      );
    });
    assert.equal(count, 1);
  }
  for (
    const response of [
      () => {
        throw new TypeError('network failed after acceptance');
      },
      () => json({}),
      () => new Response('invalid json'),
    ]
  ) {
    let count = 0;
    await withFetch(() => {
      count++;
      return response();
    }, async () => {
      await assert.rejects(
        () => provider().submit({ prompt: 'A bird' }, 'https://example.com/hook'),
        (error: unknown) => error instanceof FalSubmissionError && error.outcome === 'uncertain',
      );
    });
    assert.equal(count, 1);
  }
});

Deno.test('fal rejects invalid configuration before sending a request', async () => {
  await withFetch(() => {
    throw new Error('must not fetch');
  }, async () => {
    for (
      const callback of ['not a url', 'http://example.com/hook', 'https://user:password@example.com/hook']
    ) {
      await assert.rejects(
        () => provider().submit({ prompt: 'A bird' }, callback),
        (error: unknown) => error instanceof FalSubmissionError && error.outcome === 'rejected',
      );
    }
    await assert.rejects(() => provider().poll('../other-id'), /Invalid fal request ID/);
  });
});

Deno.test('fal polling handles queue, running, completed and definitive generation failures', async () => {
  for (const [remote, expected] of [['IN_QUEUE', 'queued'], ['IN_PROGRESS', 'running']]) {
    await withFetch((url, init) => {
      assert.equal(url.pathname, `/${FAL_MODEL}/requests/${requestId}/status`);
      assert.notEqual(init?.method, 'POST');
      return json({ status: remote });
    }, async () => assert.deepEqual(await provider().poll(requestId), { status: expected }));
  }
  let count = 0;
  await withFetch(() => {
    count++;
    return json({
      status: 'COMPLETED',
      error: 'User secret in provider output',
      error_type: 'content_policy_violation',
    });
  }, async () => {
    assert.deepEqual(await provider().poll(requestId), {
      status: 'failed',
      error: 'fal generation failed (content_policy_violation)',
    });
  });
  assert.equal(count, 1);
  const image = {
    url: 'https://v3.fal.media/files/test.png',
    content_type: 'image/png',
    width: 1024,
    height: 1024,
  };
  await withFetch(
    (url, init) => {
      assert.notEqual(init?.method, 'POST');
      if (url.pathname.endsWith('/status')) {
        return json({
          status: 'COMPLETED',
          response_url: 'https://attacker.example/steal-key',
        });
      }
      assert.equal(url.href, `https://queue.fal.run/${FAL_MODEL}/requests/${requestId}`);
      return json({ images: [image] });
    },
    async () => assert.deepEqual(await provider().poll(requestId), { status: 'succeeded', images: [image] }),
  );
});

Deno.test('fal polling leaves transient and malformed responses recoverable', async () => {
  for (const status of [401, 404, 429, 500]) {
    await withFetch(() => json({}, status), async () => {
      await assert.rejects(() => provider().poll(requestId), /fal status unavailable/);
    });
  }
  for (
    const result of [
      json({}, 503),
      json({ images: [] }),
      json({ images: [{ url: 'http://127.0.0.1/admin' }] }),
    ]
  ) {
    await withFetch(
      (url) => url.pathname.endsWith('/status') ? json({ status: 'COMPLETED' }) : result,
      async () => {
        await assert.rejects(() => provider().poll(requestId));
      },
    );
  }
  await withFetch(
    (url) => url.pathname.endsWith('/status') ? json({ status: 'COMPLETED' }) : json({}, 422),
    async () => assert.equal((await provider().poll(requestId)).status, 'failed'),
  );
});

function hex(bytes: Uint8Array) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

Deno.test('fal verifies Ed25519 signature over raw body and all headers with bounded JWKS cache', async () => {
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
  const publicKey = await crypto.subtle.exportKey('jwk', keys.publicKey);
  const raw = new TextEncoder().encode(JSON.stringify({ request_id: requestId, status: 'OK' }));
  const headers = new Headers({
    'x-fal-webhook-request-id': requestId,
    'x-fal-webhook-user-id': 'test-user',
    'x-fal-webhook-timestamp': String(Math.floor(Date.now() / 1000)),
  });
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
  const message = new TextEncoder().encode([
    requestId,
    'test-user',
    headers.get('x-fal-webhook-timestamp'),
    hex(digest),
  ].join('\n'));
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', keys.privateKey, message));
  headers.set('x-fal-webhook-signature', hex(signature));
  // Retrieval failure must fail closed, and must not poison the cache forever.
  await withFetch(() => json({}, 503), async () => assert.equal(await verifyWebhook(raw, headers), false));
  let fetches = 0;
  await withFetch((url, init) => {
    fetches++;
    assert.equal(url.href, 'https://rest.fal.ai/.well-known/jwks.json');
    assert.equal(new Headers(init?.headers).get('authorization'), null);
    assert.ok(init?.signal);
    return json({ keys: [{ kty: 'RSA', x: 'bad-key' }, publicKey] });
  }, async () => {
    assert.equal(await provider().verifyWebhook(raw, headers), true);
    assert.equal(await verifyWebhook(raw, headers), true);
    assert.equal(await verifyWebhook(new TextEncoder().encode('tampered'), headers), false);
    assert.equal(
      await verifyWebhook(new TextEncoder().encode(new TextDecoder().decode(raw) + ' '), headers),
      false,
    );
    for (
      const header of [
        'x-fal-webhook-request-id',
        'x-fal-webhook-user-id',
        'x-fal-webhook-timestamp',
        'x-fal-webhook-signature',
      ]
    ) {
      const missing = new Headers(headers);
      missing.delete(header);
      assert.equal(await verifyWebhook(raw, missing), false);
      const changed = new Headers(headers);
      changed.set(header, header.includes('signature') ? '0'.repeat(128) : 'other');
      assert.equal(await verifyWebhook(raw, changed), false);
    }
    for (
      const timestamp of [
        String(Math.floor(Date.now() / 1000) - 301),
        String(Math.floor(Date.now() / 1000) + 301),
        'NaN',
        headers.get('x-fal-webhook-timestamp') + 'suffix',
      ]
    ) {
      const changed = new Headers(headers);
      changed.set('x-fal-webhook-timestamp', timestamp);
      assert.equal(await verifyWebhook(raw, changed), false);
    }
    assert.deepEqual(parseWebhook(raw), { requestId, status: 'OK' });
    assert.throws(() => parseWebhook(new TextEncoder().encode('{"request_id":"../escape","status":"OK"}')));
  });
  assert.equal(fetches, 1);
});

Deno.test('fal image download validates allowed hosts and every redirect without forwarding API key', async () => {
  let count = 0;
  await withFetch(
    (url, init) => {
      count++;
      assert.equal(init?.redirect, 'manual');
      assert.equal(new Headers(init?.headers).get('authorization'), null);
      if (count === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://v3b.fal.media/files/output.png' },
        });
      }
      assert.equal(url.hostname, 'v3b.fal.media');
      return new Response(png, { headers: { 'content-type': 'image/png' } });
    },
    async () =>
      assert.deepEqual(await downloadImage({ url: 'https://fal.media/files/output.png' }), {
        bytes: png,
        contentType: 'image/png',
      }),
  );
  assert.equal(count, 2);

  const untrusted = [
    'http://v3.fal.media/x',
    'https://v3.fal.media.evil.example/x',
    'https://v3.fal.media:444/x',
    'https://user:password@v3.fal.media/x',
    'https://127.0.0.1/x',
    'https://storage.googleapis.com/other-bucket/x',
    'https://storage.googleapis.com/falserverless/../other-bucket/x',
  ];
  await withFetch(() => {
    throw new Error('must not fetch untrusted host');
  }, async () => {
    for (const url of untrusted) {
      await assert.rejects(() => downloadImage({ url }), /Untrusted fal image URL/);
    }
  });
  for (const location of untrusted) {
    let fetches = 0;
    await withFetch(
      () => {
        fetches++;
        return new Response(null, { status: 302, headers: { location } });
      },
      () => assert.rejects(() => downloadImage({ url: 'https://v3.fal.media/x' }), /Untrusted fal image URL/),
    );
    assert.equal(fetches, 1);
  }
});

Deno.test('fal image download caps streaming body and rejects unsupported or disguised content', async () => {
  const responses = [
    new Response(png, { headers: { 'content-type': 'image/svg+xml' } }),
    new Response('<script>bad</script>', { headers: { 'content-type': 'image/png' } }),
    new Response(png, {
      headers: { 'content-type': 'image/png', 'content-length': String(11 * 1024 * 1024) },
    }),
    new Response(new Uint8Array(10 * 1024 * 1024 + 1), { headers: { 'content-type': 'image/png' } }),
  ];
  for (const response of responses) {
    await withFetch(() => response, async () => {
      await assert.rejects(() => downloadImage({ url: 'https://v3.fal.media/file.png' }));
    });
  }
});

Deno.test('fal audio and video downloads validate MIME and signatures and normalize WAV aliases', async () => {
  const cases = [
    { download: downloadAudio, bytes: wav, mime: 'audio/wav', expected: 'audio/wav' },
    { download: downloadAudio, bytes: wav, mime: 'audio/x-wav; charset=binary', expected: 'audio/wav' },
    { download: downloadAudio, bytes: wav, mime: 'audio/vnd.wave', expected: 'audio/wav' },
    { download: downloadAudio, bytes: mp3, mime: 'audio/mpeg', expected: 'audio/mpeg' },
    {
      download: downloadAudio,
      bytes: new Uint8Array([255, 251, 144, 0]),
      mime: 'audio/mp3',
      expected: 'audio/mpeg',
    },
    { download: downloadVideo, bytes: mp4, mime: 'video/mp4', expected: 'video/mp4' },
    { download: downloadVideo, bytes: mp4, mime: 'application/octet-stream', expected: 'video/mp4' },
  ];
  for (const { download, bytes, mime, expected } of cases) {
    await withFetch(
      (_url, init) => {
        assert.equal(new Headers(init?.headers).get('authorization'), null);
        assert.equal(init?.redirect, 'manual');
        assert.ok(init?.signal);
        return new Response(bytes, { headers: { 'content-type': mime } });
      },
      async () =>
        assert.deepEqual(await download({ url: 'https://fal.media/output', content_type: 'image/png' }), {
          bytes,
          contentType: expected,
        }),
    );
  }
});

Deno.test('fal audio and video downloads reject spoofed and unsupported formats', async () => {
  const cases = [
    { download: downloadAudio, bytes: wav, mime: 'application/octet-stream' },
    { download: downloadAudio, bytes: mp4, mime: 'audio/wav' },
    { download: downloadAudio, bytes: png, mime: 'audio/mpeg' },
    { download: downloadAudio, bytes: new TextEncoder().encode('RIFF1234WEBP'), mime: 'audio/wav' },
    { download: downloadAudio, bytes: new Uint8Array([73, 68, 51]), mime: 'audio/mpeg' },
    { download: downloadAudio, bytes: new Uint8Array([255, 255, 255, 255]), mime: 'audio/mpeg' },
    { download: downloadAudio, bytes: new Uint8Array([255, 243, 144]), mime: 'audio/mpeg' },
    { download: downloadVideo, bytes: mp4, mime: 'video/webm' },
    { download: downloadVideo, bytes: wav, mime: 'video/mp4' },
    { download: downloadVideo, bytes: wav, mime: 'application/octet-stream' },
    {
      download: downloadVideo,
      bytes: new TextEncoder().encode('<html>bad</html>'),
      mime: 'application/octet-stream',
    },
    { download: downloadVideo, bytes: new TextEncoder().encode('0000ftyp'), mime: 'video/mp4' },
    { download: downloadVideo, bytes: new Uint8Array([0, 0, 0, 255, ...mp4.slice(4)]), mime: 'video/mp4' },
    { download: downloadVideo, bytes: new Uint8Array([0, 0, 0, 0, ...mp4.slice(4)]), mime: 'video/mp4' },
  ];
  for (const { download, bytes, mime } of cases) {
    await withFetch(
      () => new Response(bytes, { headers: { 'content-type': mime } }),
      () => assert.rejects(() => download({ url: 'https://fal.media/output' })),
    );
  }
});

Deno.test('fal media download validates each redirect and caps redirect chains', async () => {
  for (
    const { download, bytes, mime } of [
      { download: downloadAudio, bytes: wav, mime: 'audio/wav' },
      { download: downloadVideo, bytes: mp4, mime: 'video/mp4' },
    ]
  ) {
    let requests = 0;
    await withFetch((url, init) => {
      requests++;
      assert.equal(new Headers(init?.headers).get('authorization'), null);
      if (requests === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://storage.googleapis.com/falserverless/output' },
        });
      }
      assert.equal(url.href, 'https://storage.googleapis.com/falserverless/output');
      return new Response(bytes, { headers: { 'content-type': mime } });
    }, async () => assert.equal((await download({ url: 'https://v3b.fal.media/start' })).contentType, mime));
    assert.equal(requests, 2);

    for (
      const location of [
        'http://v3.fal.media/file',
        'https://user:password@fal.media/file',
        'https://fal.media:444/file',
        'https://fal.media.evil.example/file',
        'https://storage.googleapis.com/other/file',
      ]
    ) {
      let fetches = 0;
      await withFetch(() => {
        fetches++;
        return new Response(null, { status: 307, headers: { location } });
      }, () => assert.rejects(() => download({ url: 'https://fal.media/output' }), /Untrusted fal/));
      assert.equal(fetches, 1);
      await withFetch(() => {
        throw new Error('must not fetch untrusted URL');
      }, () => assert.rejects(() => download({ url: location }), /Untrusted fal/));
    }
    let redirects = 0;
    await withFetch(() => {
      redirects++;
      return new Response(null, { status: 302, headers: { location: '/next' } });
    }, () => assert.rejects(() => download({ url: 'https://fal.media/output' }), /Invalid fal .* redirect/));
    assert.equal(redirects, 4);
  }
});

Deno.test('fal media downloads cap declared and streamed audio at 20MB and video at 40MB', async () => {
  for (
    const { download, limit, mime } of [
      { download: downloadAudio, limit: 20 * 1024 * 1024, mime: 'audio/wav' },
      { download: downloadVideo, limit: 40 * 1024 * 1024, mime: 'video/mp4' },
    ]
  ) {
    for (const declared of [String(limit + 1), 'not-a-number']) {
      await withFetch(
        () =>
          new Response(new Uint8Array(), { headers: { 'content-type': mime, 'content-length': declared } }),
        () => assert.rejects(() => download({ url: 'https://fal.media/output' }), /size limit/),
      );
    }
    let canceled = false;
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
      cancel() {
        canceled = true;
      },
    });
    await withFetch(
      () => new Response(body, { headers: { 'content-type': mime } }),
      () => assert.rejects(() => download({ url: 'https://fal.media/output', file_size: 1 }), /size limit/),
    );
    assert.equal(canceled, true);
  }
});

function waveFile(sampleCount = 8000): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(44 + sampleCount * 2);
  const view = new DataView(bytes.buffer);
  const text = new TextEncoder();
  bytes.set(text.encode('RIFF'), 0);
  view.setUint32(4, bytes.length - 8, true);
  bytes.set(text.encode('WAVEfmt '), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set(text.encode('data'), 36);
  view.setUint32(40, sampleCount * 2, true);
  return bytes;
}

function mp4Box(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(8 + data.length);
  new DataView(bytes.buffer).setUint32(0, bytes.length);
  bytes.set(new TextEncoder().encode(type), 4);
  bytes.set(data, 8);
  return bytes;
}

function mp4File(version: 0 | 1, ticks: number | bigint = 2500, timescale = 1000): Uint8Array<ArrayBuffer> {
  const movieHeader = new Uint8Array(version === 0 ? 100 : 112);
  const view = new DataView(movieHeader.buffer);
  movieHeader[0] = version;
  view.setUint32(version === 0 ? 12 : 20, timescale);
  if (version === 0) view.setUint32(16, Number(ticks));
  else view.setBigUint64(24, BigInt(ticks));
  const moov = mp4Box('moov', mp4Box('mvhd', movieHeader));
  const bytes = new Uint8Array(mp4.length + moov.length);
  bytes.set(mp4);
  bytes.set(moov, mp4.length);
  return bytes;
}

Deno.test('fal derives WAV and MP4 durations from bounded container headers', async () => {
  assert.equal(mediaDuration(waveFile(12000), 'audio/wav'), 1.5);
  assert.equal(mediaDuration(mp4File(0), 'video/mp4'), 2.5);
  assert.equal(mediaDuration(mp4File(1, 4500000000n, 1000000000), 'video/mp4'), 4.5);
  // Typed-array offsets must not accidentally read a surrounding allocation.
  const movie = mp4File(1);
  const padded = new Uint8Array(movie.length + 20);
  padded.set(movie, 10);
  assert.equal(mediaDuration(padded.subarray(10, -10), 'video/mp4'), 2.5);

  for (
    const { download, bytes, mime, expected } of [
      { download: downloadAudio, bytes: waveFile(10000), mime: 'audio/x-wav', expected: 1.25 },
      { download: downloadVideo, bytes: mp4File(0), mime: 'video/mp4', expected: 2.5 },
    ]
  ) {
    await withFetch(
      () => new Response(bytes, { headers: { 'content-type': mime } }),
      async () =>
        assert.equal((await download({ url: 'https://fal.media/output', duration: 999 })).duration, expected),
    );
  }
});

Deno.test('fal duration extraction fails closed for malformed or unsupported containers', () => {
  for (const bytes of [new Uint8Array(), wav, waveFile().slice(0, -1)]) {
    assert.equal(mediaDuration(bytes, 'audio/wav'), undefined);
  }
  for (const [offset, value] of [[4, 0xffffffff], [16, 0xffffffff], [24, 0], [28, 123], [40, 0xffffffff]]) {
    const bytes = waveFile();
    new DataView(bytes.buffer).setUint32(offset, value, true);
    assert.equal(mediaDuration(bytes, 'audio/wav'), undefined);
  }
  const compressedWave = waveFile();
  new DataView(compressedWave.buffer).setUint16(20, 2, true);
  assert.equal(mediaDuration(compressedWave, 'audio/wav'), undefined);
  assert.equal(mediaDuration(mp3, 'audio/mpeg'), undefined);
  for (
    const bytes of [
      mp4,
      mp4File(0).slice(0, -1),
      mp4File(0, 0),
      mp4File(0, 0xffffffff),
      mp4File(1, 0xffffffffffffffffn),
      mp4File(0, 100, 0),
    ]
  ) {
    assert.equal(mediaDuration(bytes, 'video/mp4'), undefined);
  }
  const badVersion = mp4File(0);
  badVersion[mp4.length + 16] = 2;
  assert.equal(mediaDuration(badVersion, 'video/mp4'), undefined);
  const undersizedMoov = mp4File(0);
  new DataView(undersizedMoov.buffer).setUint32(mp4.length, 4);
  assert.equal(mediaDuration(undersizedMoov, 'video/mp4'), undefined);
});

Deno.test("fal polling and downloads respect the caller's earlier abort deadline", async () => {
  let aborted = 0;
  await withFetch((_url, init) =>
    new Promise((_resolve, reject) => {
      assert.ok(init?.signal);
      const abort = () => {
        aborted++;
        reject(new DOMException('Deadline reached', 'AbortError'));
      };
      if (init.signal.aborted) abort();
      else init.signal.addEventListener('abort', abort, { once: true });
    }), async () => {
    const actions = [
      (signal: AbortSignal) => provider().poll(requestId, signal),
      (signal: AbortSignal) => provider().poll(requestId, signal, audioTarget),
      (signal: AbortSignal) => downloadImage({ url: 'https://v3.fal.media/file.png' }, signal),
      (signal: AbortSignal) => downloadAudio({ url: 'https://v3.fal.media/file.wav' }, signal),
      (signal: AbortSignal) => downloadVideo({ url: 'https://v3.fal.media/file.mp4' }, signal),
    ];
    for (const action of actions) {
      const controller = new AbortController();
      const pending = action(controller.signal);
      controller.abort();
      await assert.rejects(() => pending, { name: 'AbortError' });
    }
  });
  assert.equal(aborted, 5);
});
