import { deepEqual, equal, ok } from 'node:assert/strict';
import { Ajv2020 } from 'npm:ajv@8.20.0/dist/2020.js';
import { createApp, type Dependencies } from './app.ts';
import type { Config } from './config.ts';
import { ASSET, NETWORK, PaymentGateway, type PaymentRequirements } from './payments.ts';
import { hash } from './security.ts';
import { BAZAAR, IMAGE_SERVICE, JOB_SCHEMA, openApi, serviceDocument } from './services.ts';
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
const INPUT = { prompt: 'A red sailboat' };
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

async function testApp() {
  const now = new Date().toISOString();
  const job: Job = {
    id: ID,
    service_id: IMAGE_SERVICE.id,
    service_version: IMAGE_SERVICE.version,
    input: INPUT,
    input_hash: await hash(JSON.stringify({ service: IMAGE_SERVICE.id, input: INPUT })),
    recovery_token_hash: await hash(TOKEN),
    requirements: REQUIREMENTS,
    resource_url: `${CONFIG.baseUrl}/v1/services/${IMAGE_SERVICE.id}`,
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
    config: CONFIG,
    store: new Proxy(store, {
      get: (target, name) =>
        Object.hasOwn(target, name)
          ? Reflect.getOwnPropertyDescriptor(target, name)?.value
          : Reflect.get(target, name),
    }),
    payments: {
      requirements: () => Promise.resolve(structuredClone(REQUIREMENTS)),
      challenge: gateway.challenge.bind(gateway),
      parse: () => ({ x402Version: 2, accepted: REQUIREMENTS, payload: { transaction: 'test' } }),
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
  deepEqual(service.output_schema, JOB_SCHEMA);
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
