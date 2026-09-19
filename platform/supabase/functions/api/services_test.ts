import { deepEqual, equal, ok, throws } from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { Ajv2020 } from 'npm:ajv@8.20.0/dist/2020.js';
import { StrKey } from 'npm:@stellar/stellar-sdk@16.2.0';
import { createApp, type Dependencies } from './app.ts';
import { type Config, readConfig } from './config.ts';
import { ASSET, NETWORK, PaymentGateway, type PaymentRequirements } from './payments.ts';
import { hash } from './security.ts';
import {
  BAZAAR,
  bazaarFor,
  IMAGE_SERVICE,
  JOB_SCHEMA,
  jobSchemaFor,
  openApi,
  serviceDocument,
} from './services.ts';
import {
  COMPOSE_SERVICE,
  enabledServices,
  getService,
  LEGACY_COMPOSE_SERVICE,
  normalizeInput,
  providerInput,
  type Service,
  servicePayment,
  SERVICES,
  SLIDESHOW_SERVICE,
} from './catalog.ts';
import type { Job } from './store.ts';

const CONFIG: Config = {
  supabaseUrl: 'https://db.example.test',
  serviceRoleKey: 'fake',
  falKey: 'fake',
  imagePayTo: 'GCTVT52AAFK7KYO74JAO3QOLNT6BUYTCZYHTRD7C2VZG6C5CJNRVEV6Y',
  baseUrl: 'https://api.example.test',
  facilitatorUrl: 'https://facilitator.example.test',
  priceAtomic: '100000',
};
const ALL_CONFIG: Config = {
  ...CONFIG,
  servicePayments: {
    'video.social': { payTo: StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 6)), priceAtomic: '1100000' },
    'speech.generate': { payTo: StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 2)), priceAtomic: '200000' },
    'video.slideshow': { payTo: StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 5)), priceAtomic: '100000' },
    'video.compose': { payTo: StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 3)), priceAtomic: '300000' },
    'video.caption': { payTo: StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 4)), priceAtomic: '400000' },
  },
};
const REQUIREMENTS: PaymentRequirements = {
  scheme: 'exact',
  network: NETWORK,
  asset: ASSET,
  amount: '100000',
  payTo: CONFIG.imagePayTo,
  maxTimeoutSeconds: 120,
  extra: { areFeesSponsored: true },
};
const ID = '00000000-0000-4000-8000-000000000001';
const TOKEN = 'a'.repeat(43);
const INPUT = IMAGE_SERVICE.exampleInput;
const api = openApi(CONFIG);
const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addFormat('uri', (value: string) => {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
});
ajv.addFormat('uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
ajv.addFormat(
  'date-time',
  (value: string) => /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)),
);

type ResponseDocumentation = { content: { 'application/json': { schema: unknown } } };
const paths = api.paths as unknown as Record<
  string,
  Record<string, { responses: Record<string, ResponseDocumentation> }>
>;
function responseSchema(path: string, method: string, status: number) {
  const definition = paths[path][method].responses[status];
  ok(definition, `${method} ${path} must document HTTP ${status}`);
  return definition.content['application/json'].schema;
}
function validator(schema: unknown) {
  // Preserve OpenAPI's document-local component references when compiling an
  // individual response schema with the JSON Schema 2020-12 validator.
  return ajv.compile({ ...(schema as object), components: api.components });
}
function assertConforms(schema: unknown, body: unknown) {
  const validate = validator(schema);
  ok(validate(body), JSON.stringify(validate.errors));
}
function unavailable<T extends object>(): T {
  return new Proxy({} as T, {
    get: (_target, name) => () => {
      throw new Error(`Unexpected dependency call: ${String(name)}`);
    },
  });
}

async function testApp(config: Config = CONFIG, service: Service = IMAGE_SERVICE) {
  const input = normalizeInput(service, service.exampleInput);
  const payment = servicePayment(config, service.id)!;
  const requirements: PaymentRequirements = {
    ...REQUIREMENTS,
    payTo: payment.payTo,
    amount: payment.priceAtomic,
  };
  const now = new Date().toISOString();
  const job: Job = {
    id: ID,
    service_id: service.id,
    service_version: service.version,
    input,
    input_hash: await hash(JSON.stringify({ service: service.id, input })),
    recovery_token_hash: await hash(TOKEN),
    requirements,
    resource_url: `${config.baseUrl}/v1/services/${service.id}`,
    status: 'awaiting_payment',
    payer: null,
    payment_receipt: null,
    provider_request_id: null,
    output: null,
    error: null,
    created_at: now,
    updated_at: now,
    expires_at: new Date(Date.now() + 600_000).toISOString(),
  };
  const gateway = new PaymentGateway();
  const store = unavailable<Dependencies['store']>();
  Object.assign(store, {
    get: (id: string) => Promise.resolve(id === ID ? structuredClone(job) : null),
    capacity: () =>
      Promise.resolve({ available: true, totalUsed: 0, active: 0, maxTotal: 10, maxConcurrent: 2 }),
  });
  const deps: Dependencies = {
    config,
    store: new Proxy(store, {
      get: (target, name) =>
        Object.hasOwn(target, name)
          ? Reflect.getOwnPropertyDescriptor(target, name)?.value
          : Reflect.get(target, name),
    }),
    payments: {
      requirements: (payTo: string, amount: string) => Promise.resolve({ ...REQUIREMENTS, payTo, amount }),
      challenge: gateway.challenge.bind(gateway),
      parse: () => ({ x402Version: 2, accepted: requirements, payload: { transaction: 'test' } }),
      verify: () => Promise.resolve({ valid: false, reason: 'invalid-payment' }),
      fingerprint: unavailable<Dependencies['payments']>().fingerprint,
      settle: unavailable<Dependencies['payments']>().settle,
    },
    fal: unavailable<Dependencies['fal']>(),
    artifacts: unavailable<Dependencies['artifacts']>(),
  };
  return createApp(deps);
}

Deno.test('read-only route responses validate against their own OpenAPI schemas', async () => {
  const app = await testApp();
  for (
    const [url, route] of [
      ['/health', '/health'],
      ['/openapi.json', '/openapi.json'],
      ['/discovery/resources', '/discovery/resources'],
      ['/discovery/search?query=image', '/discovery/search'],
      ['/v1/services/image.generate', '/v1/services/{service_id}'],
    ]
  ) {
    const response = await app.request(url);
    equal(response.status, 200);
    const body = await response.json();
    assertConforms(responseSchema(route, 'get', 200), body);
    equal(Object.hasOwn(body, 'job_id'), false);
  }
});

Deno.test('GET errors use error schemas instead of requiring a job identity', async () => {
  const app = await testApp();
  for (
    const [url, route, status] of [
      ['/discovery/search', '/discovery/search', 400],
      ['/discovery/resources?limit=0', '/discovery/resources', 400],
      ['/v1/services/missing', '/v1/services/{service_id}', 404],
      ['/v1/jobs/not-a-uuid', '/v1/jobs/{job_id}', 404],
    ] as const
  ) {
    const response = await app.request(url);
    equal(response.status, status);
    assertConforms(responseSchema(route, 'get', status), await response.json());
  }
});

Deno.test('discovery pagination and exact filters retain their actual response contracts', async () => {
  const app = await testApp();
  for (const [query, total] of [['network=stellar:pubnet', 0], ['offset=1&limit=1', 1]] as const) {
    const response = await app.request(`/discovery/resources?${query}`);
    const body = await response.json();
    assertConforms(responseSchema('/discovery/resources', 'get', 200), body);
    equal(body.resources.length, 0);
    equal(body.pagination.total, total);
    equal(body.pagination.cursor, null);
  }
  const names = api.paths['/discovery/resources'].get.parameters.map((parameter) => parameter.name);
  for (const name of ['query', 'type', 'network', 'scheme', 'payTo', 'extensions', 'limit', 'offset']) {
    ok(names.includes(name));
  }
});

Deno.test('actual unpaid challenge and invalid-payment 402 bodies both match the advertised union', async () => {
  const app = await testApp();
  for (const paid of [false, true]) {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'Idempotency-Key': ID,
      'X-Recovery-Token': TOKEN,
    };
    if (paid) headers['PAYMENT-SIGNATURE'] = 'invalid-authorization';
    const response = await app.request('/v1/services/image.generate', {
      method: 'POST',
      headers,
      body: JSON.stringify(INPUT),
    });
    equal(response.status, 402);
    const body = await response.json();
    assertConforms(responseSchema('/v1/services/{service_id}', 'post', 402), body);
    if (paid) equal(body.code, 'invalid-payment');
    else {
      equal(body.x402Version, 2);
      ok(response.headers.get('PAYMENT-REQUIRED'));
    }
  }
  assertConforms(responseSchema('/v1/services/{service_id}', 'post', 402), {
    code: 'payment-failed',
    job_id: ID,
    payment: { success: false, network: NETWORK, transaction: '', errorReason: 'verification_failed' },
  });
});

Deno.test('service output schema and OpenAPI Job share the same complete result contract', () => {
  const service = serviceDocument(CONFIG, REQUIREMENTS);
  deepEqual(service.output_schema, jobSchemaFor(IMAGE_SERVICE));
  deepEqual(api.components.schemas.Job, JOB_SCHEMA);
  const output = BAZAAR.info.output.example;
  assertConforms(JOB_SCHEMA, output);
  assertConforms(BAZAAR.schema, BAZAAR.info);
  for (const code of [200, 202, 502]) {
    deepEqual(responseSchema('/v1/services/{service_id}', 'post', code), {
      $ref: '#/components/schemas/Job',
    });
  }
  for (const status of ['queued', 'result-ready', 'failed', 'payment-uncertain']) {
    assertConforms(JOB_SCHEMA, {
      ...output,
      status,
      output: null,
      error: status === 'failed' ? { code: 'generation-failed' } : null,
    });
  }
  const validate = validator(JOB_SCHEMA);
  equal(
    validate({
      ...output,
      output: { images: [{ url: 'https://example.com/image.png' }], url_expires_in: 3600 },
    }),
    false,
  );
  equal(
    validate({
      ...output,
      output: { images: [{ url: 'not-an-absolute-url', content_type: 'image/png' }], url_expires_in: 3600 },
    }),
    false,
  );
  equal(validate({ ...output, status: 'invented-state' }), false);
});

Deno.test('actual invalid input matches the documented POST error shape', async () => {
  const app = await testApp();
  const response = await app.request('/v1/services/image.generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': ID, 'X-Recovery-Token': TOKEN },
    body: JSON.stringify({ prompt: '' }),
  });
  equal(response.status, 400);
  assertConforms(responseSchema('/v1/services/{service_id}', 'post', 400), await response.json());
});

Deno.test('all service documents publish matching public schemas without provider configuration', () => {
  equal(SERVICES.length, 6);
  for (const service of SERVICES) {
    const payment = servicePayment(ALL_CONFIG, service.id)!;
    const requirements = { ...REQUIREMENTS, payTo: payment.payTo, amount: payment.priceAtomic };
    const document = serviceDocument(ALL_CONFIG, requirements, service);
    equal(document.id, service.id);
    equal(document.version, service.version);
    equal(document.resource, `${ALL_CONFIG.baseUrl}/v1/services/${service.id}`);
    deepEqual(document.input_schema, service.inputSchema);
    deepEqual(document.accepts, [requirements]);
    deepEqual(document.output_schema, jobSchemaFor(service));
    for (const key of ['model', 'queuePath', 'providerOutput', 'inputSchema', 'exampleInput', 'outputKind']) {
      equal(Object.hasOwn(document, key), false, `${service.id} must not expose ${key}`);
    }
    const bazaar = bazaarFor(service);
    deepEqual(document.extensions.bazaar, bazaar);
    deepEqual(bazaar.info.input.body, service.exampleInput);
    assertConforms(service.inputSchema, service.exampleInput);
    assertConforms(bazaar.schema, bazaar.info);
    assertConforms(document.output_schema, bazaar.info.output.example);
    assertConforms(JOB_SCHEMA, bazaar.info.output.example);
    const validate = validator(service.inputSchema);
    equal(validate({ ...service.exampleInput, unsupported: true }), false);
    equal(validate({}), false);
  }
});

Deno.test('service output contracts reject another service or media kind and validate media details', () => {
  for (const service of SERVICES) {
    const example = bazaarFor(service).info.output.example;
    const validate = validator(jobSchemaFor(service));
    const other = SERVICES.find((candidate) => candidate.outputKind !== service.outputKind)!;
    equal(validate({ ...example, service_id: other.id }), false);
    equal(validate({ ...example, output: bazaarFor(other).info.output.example.output }), false);
    const media = service.outputKind === 'images'
      ? {
        url: 'https://storage.example.test/image.png',
        content_type: 'image/png',
        width: 1024,
        height: 1024,
      }
      : service.outputKind === 'audio'
      ? { url: 'https://storage.example.test/audio.wav', content_type: 'audio/wav' }
      : {
        url: 'https://storage.example.test/video.mp4',
        content_type: 'video/mp4',
        width: 1024,
        height: 1024,
      };
    const withMedia = (value: unknown) => ({
      ...example,
      output: {
        [service.outputKind]: service.outputKind === 'images' ? [value] : value,
        url_expires_in: 3600,
      },
    });
    assertConforms(jobSchemaFor(service), withMedia({ ...media, file_size: 12000, duration: 2.5 }));
    equal(validate(withMedia({ ...media, file_size: -1 })), false);
    equal(validate(withMedia({ ...media, duration: -1 })), false);
    equal(validate(withMedia({ ...media, content_type: 'application/octet-stream' })), false);
    equal(validate(withMedia({ url: media.url })), false);
    for (const status of ['awaiting_payment', 'queued', 'running', 'failed', 'result-ready']) {
      assertConforms(jobSchemaFor(service), { ...example, status, output: null, payment: null });
    }
  }
});

Deno.test('OpenAPI exposes exact enabled service paths and request examples', () => {
  const full = openApi(ALL_CONFIG);
  const generic = full.paths['/v1/services/{service_id}'];
  deepEqual(generic.parameters[0].schema.enum, SERVICES.map((service) => service.id));
  deepEqual(
    Object.keys(generic.post.requestBody.content['application/json'].examples),
    SERVICES.map((s) => s.id),
  );
  for (const service of SERVICES) {
    const path = (full.paths as unknown as Record<string, { post: typeof generic.post }>)[
      `/v1/services/${service.id}`
    ];
    ok(path, service.id);
    const post = path.post as typeof generic.post;
    const request = post.requestBody.content['application/json'];
    deepEqual(request.schema, service.inputSchema);
    deepEqual((request as unknown as { example: unknown }).example, service.exampleInput);
    for (const status of ['200', '202', '502']) {
      const response = post.responses[status as '200'];
      deepEqual(response.content['application/json'].schema, jobSchemaFor(service));
    }
  }
  const legacy = openApi(CONFIG);
  deepEqual(legacy.paths['/v1/services/{service_id}'].parameters[0].schema.enum, ['image.generate']);
  for (const service of SERVICES.filter((service) => service.id !== 'image.generate')) {
    equal(Object.hasOwn(legacy.paths, `/v1/services/${service.id}`), false);
    equal(
      Object.hasOwn(
        legacy.paths['/v1/services/{service_id}'].post.requestBody.content['application/json'].examples,
        service.id,
      ),
      false,
    );
  }
});

Deno.test('six-service discovery paginates and filters by recipient, tags, and protocol', async () => {
  const app = await testApp(ALL_CONFIG);
  const all = await (await app.request('/discovery/resources')).json();
  equal(all.pagination.total, 6);
  deepEqual(all.resources.map((s: { id: string }) => s.id), SERVICES.map((s) => s.id));
  deepEqual(all.resources.map((s: { version: string }) => s.version), ['1', '1', '1', '2', '1', '1']);
  equal(new Set(all.resources.map((s: { accepts: { payTo: string }[] }) => s.accepts[0].payTo)).size, 6);
  for (const [offset, limit] of [[0, 2], [2, 2], [4, 2], [6, 2]]) {
    const page = await (await app.request(`/discovery/resources?offset=${offset}&limit=${limit}`)).json();
    equal(page.pagination.total, 6);
    equal(page.pagination.offset, offset);
    equal(page.pagination.limit, limit);
    equal(page.pagination.cursor, null);
    deepEqual(
      page.resources.map((s: { id: string }) => s.id),
      SERVICES.slice(offset, offset + limit).map((s) => s.id),
    );
  }
  for (const service of SERVICES) {
    const payment = servicePayment(ALL_CONFIG, service.id)!;
    const page = await (await app.request(
      `/discovery/resources?payTo=${payment.payTo}&type=http&network=stellar:testnet&scheme=exact&extensions=bazaar`,
    )).json();
    deepEqual(page.resources.map((s: { id: string }) => s.id), [service.id]);
    equal(page.resources[0].accepts[0].amount, payment.priceAtomic);
    equal(page.resources[0].accepts[0].payTo, payment.payTo);
  }
  const video = await (await app.request('/discovery/search?query=video')).json();
  deepEqual(video.resources.map((s: { id: string }) => s.id), [
    'video.slideshow',
    'video.compose',
    'video.caption',
    'video.social',
  ]);
  for (
    const query of [
      'network=stellar:pubnet',
      'type=other',
      'scheme=other',
      'extensions=other',
      'payTo=missing',
    ]
  ) {
    const page = await (await app.request(`/discovery/resources?${query}`)).json();
    equal(page.resources.length, 0);
    equal(page.pagination.total, 0);
  }
  const legacy = await testApp();
  equal((await legacy.request('/v1/services/video.compose')).status, 404);
  deepEqual(enabledServices(CONFIG).map((s) => s.id), ['image.generate']);
});

Deno.test('each unpaid service challenge advertises its own resource, payment and Bazaar contract', async () => {
  for (const service of SERVICES) {
    const app = await testApp(ALL_CONFIG, service);
    const response = await app.request(`/v1/services/${service.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': ID, 'X-Recovery-Token': TOKEN },
      body: JSON.stringify(service.exampleInput),
    });
    equal(response.status, 402, service.id);
    const body = await response.json();
    const payment = servicePayment(ALL_CONFIG, service.id)!;
    equal(body.resource.url, `${ALL_CONFIG.baseUrl}/v1/services/${service.id}`);
    equal(body.resource.description, service.description);
    equal(body.accepts[0].payTo, payment.payTo);
    equal(body.accepts[0].amount, payment.priceAtomic);
    deepEqual(body.extensions.bazaar, bazaarFor(service));
    assertConforms(bazaarFor(service).schema, body.extensions.bazaar.info);
    const header = response.headers.get('PAYMENT-REQUIRED');
    ok(header);
    const headerBody = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    deepEqual(headerBody.resource, body.resource);
    deepEqual(headerBody.accepts, body.accepts);
    deepEqual(headerBody.extensions.bazaar, body.extensions.bazaar);
  }
});

Deno.test('service version lookup preserves legacy composition without advertising it', () => {
  equal(getService('video.compose'), COMPOSE_SERVICE);
  equal(getService('video.compose', '2'), COMPOSE_SERVICE);
  equal(getService('video.compose', '1'), LEGACY_COMPOSE_SERVICE);
  equal(getService('video.compose', '3'), undefined);
  equal(getService('video.slideshow', '1'), SLIDESHOW_SERVICE);
  equal(getService('video.slideshow', '2'), undefined);
  equal(getService('unknown', '1'), undefined);
  equal(SERVICES.includes(LEGACY_COMPOSE_SERVICE), false);
  const legacy = normalizeInput(LEGACY_COMPOSE_SERVICE, LEGACY_COMPOSE_SERVICE.exampleInput);
  assertConforms(LEGACY_COMPOSE_SERVICE.inputSchema, legacy);
  deepEqual(providerInput(LEGACY_COMPOSE_SERVICE, legacy), {
    tracks: [
      {
        id: 'visuals',
        type: 'image',
        keyframes: [{
          url: 'https://storage.example.com/image.png?token=example',
          timestamp: 0,
          duration: 20000,
        }],
      },
      {
        id: 'narration',
        type: 'audio',
        keyframes: [{
          url: 'https://storage.example.com/audio.wav?token=example',
          timestamp: 0,
          duration: 20000,
        }],
      },
    ],
  });
  throws(() => normalizeInput(COMPOSE_SERVICE, legacy));
  throws(() => normalizeInput(LEGACY_COMPOSE_SERVICE, COMPOSE_SERVICE.exampleInput));
  const full = openApi(ALL_CONFIG);
  const schema =
    full.paths['/v1/services/{service_id}'].get.responses['200'].content['application/json'].schema;
  const validate = validator(schema);
  equal(validate(serviceDocument(ALL_CONFIG, REQUIREMENTS, LEGACY_COMPOSE_SERVICE)), false);
  equal(validate(serviceDocument(ALL_CONFIG, REQUIREMENTS, COMPOSE_SERVICE)), true);
  const legacyJob = bazaarFor(LEGACY_COMPOSE_SERVICE).info.output.example;
  assertConforms(JOB_SCHEMA, legacyJob);
  assertConforms(jobSchemaFor(LEGACY_COMPOSE_SERVICE), legacyJob);
  equal(validator(jobSchemaFor(COMPOSE_SERVICE))(legacyJob), false);
  equal(validator(JOB_SCHEMA)({ ...legacyJob, service_version: '3' }), false);
  equal(validator(JOB_SCHEMA)({ ...BAZAAR.info.output.example, service_version: '2' }), false);
});

Deno.test('saved version-one composition retains its original unpaid challenge contract', async () => {
  const app = await testApp(ALL_CONFIG, LEGACY_COMPOSE_SERVICE);
  const response = await app.request('/v1/services/video.compose', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': ID, 'X-Recovery-Token': TOKEN },
    body: JSON.stringify(LEGACY_COMPOSE_SERVICE.exampleInput),
  });
  equal(response.status, 402);
  const body = await response.json();
  deepEqual(body.extensions.bazaar, bazaarFor(LEGACY_COMPOSE_SERVICE));
  equal(body.resource.description, LEGACY_COMPOSE_SERVICE.description);
});

Deno.test('slideshow maps ordered scenes to explicit frame holds without cumulative duration loss', () => {
  const urls = ['first', 'second', 'third'].map((name) => `https://storage.example.test/${name}.png?token=x`);
  const normalize = (durations: number[]) =>
    normalizeInput(SLIDESHOW_SERVICE, {
      images: durations.map((duration_seconds, index) => ({ url: urls[index], duration_seconds })),
    });
  deepEqual(providerInput(SLIDESHOW_SERVICE, normalize([5, 5, 5])), {
    images: [
      { url: urls[0], frames: 120 },
      { url: urls[1], frames: 120 },
      { url: urls[2], frames: 118 },
      { url: urls[2], frames: 1 },
      { url: urls[2], frames: 1 },
    ],
    fps: 24,
  });
  deepEqual(providerInput(SLIDESHOW_SERVICE, normalize([10.001, 9.999, 10])), {
    images: [
      { url: urls[0], frames: 241 },
      { url: urls[1], frames: 239 },
      { url: urls[2], frames: 238 },
      { url: urls[2], frames: 1 },
      { url: urls[2], frames: 1 },
    ],
    fps: 24,
  });
  deepEqual(providerInput(SLIDESHOW_SERVICE, normalize([0.501, 0.501])), {
    images: [
      { url: urls[0], frames: 13 },
      { url: urls[1], frames: 10 },
      { url: urls[1], frames: 1 },
      { url: urls[1], frames: 1 },
    ],
    fps: 24,
  });
  deepEqual(providerInput(SLIDESHOW_SERVICE, normalize([30])), {
    images: [{ url: urls[0], frames: 718 }, { url: urls[0], frames: 1 }, { url: urls[0], frames: 1 }],
    fps: 24,
  });
  equal(SLIDESHOW_SERVICE.model, 'fal-ai/ffmpeg-api/images-to-video');
  equal(SLIDESHOW_SERVICE.queuePath, 'fal-ai/ffmpeg-api');
  equal(SLIDESHOW_SERVICE.providerOutput, 'video');
  for (const durations of [[], [0.5], [0.49, 1], [30.001], [10, 10, 10.001], Array(7).fill(1)]) {
    throws(() => normalize(durations));
  }
  throws(() =>
    normalizeInput(SLIDESHOW_SERVICE, { ...normalize([5]), audio_url: 'https://example.test/a.wav' })
  );
  for (
    const [durations, expectedFrames] of [[[5, 5, 5], 360], [[30], 720], [Array(6).fill(5), 720]] as const
  ) {
    const input = normalizeInput(SLIDESHOW_SERVICE, {
      images: durations.map((duration_seconds) => ({ url: urls[0], duration_seconds })),
    });
    const output = providerInput(SLIDESHOW_SERVICE, input);
    const images = output.images as { url: string; frames: number }[];
    equal(images.length, durations.length + 2);
    equal(images.reduce((sum, image) => sum + image.frames, 0), expectedFrames);
    ok(images.every((image) => image.frames >= 1));
    deepEqual(images.at(-1), { url: urls[0], frames: 1 });
    deepEqual(images.at(-2), { url: urls[0], frames: 1 });
  }
});

Deno.test('compose version two accepts only slideshow and narration URLs and maps one merge request', () => {
  const input = normalizeInput(COMPOSE_SERVICE, COMPOSE_SERVICE.exampleInput);
  deepEqual(providerInput(COMPOSE_SERVICE, input), {
    video_url: 'https://storage.example.com/slideshow.mp4?token=example',
    audio_url: 'https://storage.example.com/audio.wav?token=example',
    start_offset: 0,
  });
  equal(COMPOSE_SERVICE.version, '2');
  equal(COMPOSE_SERVICE.model, 'fal-ai/ffmpeg-api/merge-audio-video');
  equal(COMPOSE_SERVICE.queuePath, 'fal-ai/ffmpeg-api');
  equal(COMPOSE_SERVICE.providerOutput, 'video');
  for (
    const value of [{}, { video_url: input.video_url }, { audio_url: input.audio_url }, {
      ...input,
      start_offset: 1,
    }]
  ) {
    throws(() => normalizeInput(COMPOSE_SERVICE, value));
    equal(validator(COMPOSE_SERVICE.inputSchema)(value), false);
  }
});

Deno.test('slideshow configuration defaults to its own 0.01 test USDC recipient', () => {
  const prefixes = ['IMAGE_GENERATE', 'SPEECH_GENERATE', 'VIDEO_SLIDESHOW', 'VIDEO_COMPOSE', 'VIDEO_CAPTION'];
  const names = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'FAL_KEY',
    ...prefixes.flatMap((prefix) => [`${prefix}_PAY_TO`, `${prefix}_PRICE_ATOMIC`]),
  ];
  const previous = new Map(names.map((name) => [name, Deno.env.get(name)]));
  try {
    for (const name of names) Deno.env.delete(name);
    Deno.env.set('SUPABASE_URL', CONFIG.supabaseUrl);
    Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'test-key');
    Deno.env.set('FAL_KEY', 'test-key');
    Deno.env.set('IMAGE_GENERATE_PAY_TO', CONFIG.imagePayTo);
    const recipient = ALL_CONFIG.servicePayments!['video.slideshow'].payTo;
    Deno.env.set('VIDEO_SLIDESHOW_PAY_TO', recipient);
    deepEqual(readConfig().servicePayments, {
      'video.slideshow': { payTo: recipient, priceAtomic: '100000' },
    });
    Deno.env.set('VIDEO_SLIDESHOW_PAY_TO', CONFIG.imagePayTo);
    throws(() => readConfig(), /requires its own valid recipient/);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
});
