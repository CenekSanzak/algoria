import { strict as assert } from 'node:assert';
import {
  downloadImage,
  FAL_MODEL,
  FalProvider,
  FalSubmissionError,
  parseWebhook,
  verifyWebhook,
} from './fal.ts';

const requestId = '80e732af-660e-45cd-bd63-580e4f2a94cc';
const provider = () => new FalProvider('test-key-not-a-secret');
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);

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
      (signal: AbortSignal) => downloadImage({ url: 'https://v3.fal.media/file.png' }, signal),
    ];
    for (const action of actions) {
      const controller = new AbortController();
      const pending = action(controller.signal);
      controller.abort();
      await assert.rejects(() => pending, { name: 'AbortError' });
    }
  });
  assert.equal(aborted, 2);
});
