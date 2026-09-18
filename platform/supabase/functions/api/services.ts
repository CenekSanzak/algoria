import type { Config } from './config.ts';

export const INPUT_SCHEMA = {
  type: 'object',
  properties: { prompt: { type: 'string', minLength: 1, maxLength: 4000 } },
  required: ['prompt'],
  additionalProperties: false,
};
export const MODES = {
  supported: ['sync', 'async'],
  default: 'sync',
  default_wait_ms: 45000,
  max_wait_ms: 60000,
};
export const IMAGE_SERVICE = {
  id: 'image.generate',
  version: '1',
  name: 'Algoria Image Generation',
  description: 'Generate one square 1K PNG image from a text prompt.',
  tags: ['image', 'generation', 'design', 'art', 'visual'],
};

const nullable = (schema: unknown) => ({ anyOf: [schema, { type: 'null' }] });
const PAYMENT_RECEIPT_SCHEMA = {
  type: 'object',
  required: ['success', 'network', 'transaction'],
  properties: {
    success: { type: 'boolean' },
    network: { const: 'stellar:testnet' },
    transaction: { type: 'string' },
    payer: { type: 'string' },
    amount: { type: 'string', pattern: '^\\d+$' },
    errorReason: { type: 'string' },
    errorMessage: { type: 'string' },
    extensions: { type: 'object' },
    extra: { type: 'object' },
  },
};
export const ERROR_SCHEMA = {
  type: 'object',
  required: ['code'],
  properties: {
    code: { type: 'string' },
    message: { type: 'string' },
    job_id: { type: 'string', format: 'uuid' },
    payment: PAYMENT_RECEIPT_SCHEMA,
  },
  additionalProperties: false,
};
export const JOB_SCHEMA = {
  type: 'object',
  required: ['job_id', 'service_id', 'status', 'status_url', 'payment', 'output', 'error'],
  properties: {
    job_id: { type: 'string', format: 'uuid' },
    service_id: { const: IMAGE_SERVICE.id },
    status: {
      enum: [
        'awaiting_payment',
        'settling',
        'payment-uncertain',
        'paid',
        'submitting',
        'submission-uncertain',
        'queued',
        'running',
        'saving',
        'succeeded',
        'failed',
        'result-ready',
      ],
    },
    status_url: { type: 'string', format: 'uri' },
    poll_after_ms: { type: 'integer', minimum: 0 },
    payment: nullable(PAYMENT_RECEIPT_SCHEMA),
    output: nullable({
      type: 'object',
      required: ['images', 'url_expires_in'],
      additionalProperties: false,
      properties: {
        images: {
          type: 'array',
          minItems: 1,
          maxItems: 1,
          items: {
            type: 'object',
            required: ['url', 'content_type'],
            additionalProperties: false,
            properties: {
              url: { type: 'string', format: 'uri' },
              content_type: { enum: ['image/png', 'image/jpeg', 'image/webp'] },
              width: { type: 'integer', minimum: 1 },
              height: { type: 'integer', minimum: 1 },
            },
          },
        },
        url_expires_in: { type: 'integer', minimum: 1, description: 'Signed image URL lifetime in seconds.' },
      },
    }),
    error: nullable(ERROR_SCHEMA),
    message: { type: 'string' },
  },
  additionalProperties: false,
};

const exampleId = '00000000-0000-4000-8000-000000000001';
export const BAZAAR = {
  info: {
    input: {
      type: 'http',
      method: 'POST',
      bodyType: 'json',
      body: { prompt: 'A small red sailboat on a calm turquoise sea, watercolor illustration.' },
      queryParams: { mode: 'sync' },
      headers: {
        'Idempotency-Key': 'YOUR_UUID_V4',
        'X-Recovery-Token': 'YOUR_RANDOM_32_BYTE_BASE64URL_TOKEN',
      },
    },
    output: {
      type: 'json',
      example: {
        job_id: exampleId,
        service_id: IMAGE_SERVICE.id,
        status: 'succeeded',
        status_url: `https://api.example.com/v1/jobs/${exampleId}`,
        payment: { success: true, network: 'stellar:testnet', transaction: '0'.repeat(64) },
        output: {
          images: [{
            url: 'https://storage.example.com/image.png?token=example',
            content_type: 'image/png',
            width: 1024,
            height: 1024,
          }],
          url_expires_in: 3600,
        },
        error: null,
      },
    },
  },
  schema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: ['input'],
    properties: {
      input: {
        type: 'object',
        required: ['type', 'method', 'bodyType', 'body'],
        additionalProperties: false,
        properties: {
          type: { const: 'http' },
          method: { const: 'POST' },
          bodyType: { const: 'json' },
          body: INPUT_SCHEMA,
          queryParams: {
            type: 'object',
            properties: { mode: { enum: ['sync', 'async'] }, wait_ms: { type: 'string' } },
          },
          headers: { type: 'object', additionalProperties: { type: 'string' } },
        },
      },
      output: {
        type: 'object',
        properties: { type: { const: 'json' }, example: JOB_SCHEMA },
        required: ['type'],
      },
    },
  },
};

export function serviceDocument(config: Config, requirements: unknown) {
  return {
    ...IMAGE_SERVICE,
    type: 'http',
    x402Version: 2,
    resource: `${config.baseUrl}/v1/services/${IMAGE_SERVICE.id}`,
    method: 'POST',
    input_schema: INPUT_SCHEMA,
    output_schema: JOB_SCHEMA,
    execution: MODES,
    accepts: [requirements],
    extensions: { bazaar: BAZAAR },
    headers: {
      'Idempotency-Key': 'Required UUID v4; preserve it on retries.',
      'X-Recovery-Token': 'Required random 32-byte base64url secret; preserve locally. Never put in a URL.',
      'PAYMENT-SIGNATURE': 'Standard x402 v2 payment authorization, after receiving 402.',
    },
    responses: {
      '200': 'Completed result and payment receipt',
      '202': 'Same job continues; poll status_url with recovery token',
      '402': 'Payment required; no generation started',
    },
    recovery: {
      method: 'GET',
      url_template: `${config.baseUrl}/v1/jobs/{job_id}`,
      authorization: 'Bearer <recovery token>',
      polling_interval_ms: 3000,
    },
  };
}

const PAYMENT_REQUIREMENTS_SCHEMA = {
  type: 'object',
  required: ['scheme', 'network', 'asset', 'amount', 'payTo', 'maxTimeoutSeconds', 'extra'],
  properties: {
    scheme: { const: 'exact' },
    network: { const: 'stellar:testnet' },
    asset: { type: 'string' },
    amount: { type: 'string', pattern: '^[1-9]\\d*$' },
    payTo: { type: 'string' },
    maxTimeoutSeconds: { type: 'integer', minimum: 1 },
    extra: {
      type: 'object',
      required: ['areFeesSponsored'],
      properties: { areFeesSponsored: { const: true } },
    },
  },
};
const SERVICE_DOCUMENT_SCHEMA = {
  type: 'object',
  required: [
    'id',
    'version',
    'name',
    'description',
    'tags',
    'type',
    'x402Version',
    'resource',
    'method',
    'input_schema',
    'output_schema',
    'execution',
    'accepts',
    'extensions',
    'headers',
    'responses',
    'recovery',
  ],
  properties: {
    id: { const: IMAGE_SERVICE.id },
    version: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    type: { const: 'http' },
    x402Version: { const: 2 },
    resource: { type: 'string', format: 'uri' },
    method: { const: 'POST' },
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
    execution: {
      type: 'object',
      required: ['supported', 'default', 'default_wait_ms', 'max_wait_ms'],
      properties: {
        supported: { type: 'array', items: { enum: ['sync', 'async'] } },
        default: { const: 'sync' },
        default_wait_ms: { type: 'integer' },
        max_wait_ms: { type: 'integer' },
      },
    },
    accepts: { type: 'array', minItems: 1, items: PAYMENT_REQUIREMENTS_SCHEMA },
    extensions: {
      type: 'object',
      required: ['bazaar'],
      properties: {
        bazaar: {
          type: 'object',
          required: ['info', 'schema'],
          properties: { info: { type: 'object' }, schema: { type: 'object' } },
        },
      },
    },
    headers: { type: 'object', additionalProperties: { type: 'string' } },
    responses: { type: 'object', additionalProperties: { type: 'string' } },
    recovery: {
      type: 'object',
      required: ['method', 'url_template', 'authorization', 'polling_interval_ms'],
      properties: {
        method: { const: 'GET' },
        url_template: { type: 'string' },
        authorization: { type: 'string' },
        polling_interval_ms: { type: 'integer' },
      },
    },
  },
};
const DISCOVERY_SCHEMA = {
  type: 'object',
  required: ['x402Version', 'resources', 'pagination'],
  properties: {
    x402Version: { const: 2 },
    resources: { type: 'array', items: SERVICE_DOCUMENT_SCHEMA },
    pagination: {
      type: 'object',
      required: ['limit', 'offset', 'total', 'cursor'],
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        offset: { type: 'integer', minimum: 0 },
        total: { type: 'integer', minimum: 0 },
        cursor: { type: 'null' },
      },
    },
  },
};
const PAYMENT_CHALLENGE_SCHEMA = {
  type: 'object',
  required: ['x402Version', 'resource', 'accepts', 'job_id', 'expires_at'],
  properties: {
    x402Version: { const: 2 },
    error: { type: 'string' },
    resource: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string', format: 'uri' },
        description: { type: 'string' },
        mimeType: { const: 'application/json' },
      },
    },
    accepts: { type: 'array', minItems: 1, items: PAYMENT_REQUIREMENTS_SCHEMA },
    extensions: { type: 'object' },
    job_id: { type: 'string', format: 'uuid' },
    expires_at: { type: 'string', format: 'date-time' },
  },
};

export function openApi(config: Config) {
  const health = {
    type: 'object',
    required: ['ok', 'service', 'network', 'version'],
    properties: {
      ok: { const: true },
      service: { const: 'algoria' },
      network: { const: 'stellar:testnet' },
      version: { type: 'string' },
    },
  };
  const response = (description: string, schema: unknown) => ({
    description,
    content: { 'application/json': { schema } },
  });
  const job = { $ref: '#/components/schemas/Job' };
  const error = { $ref: '#/components/schemas/Error' };
  const unavailable = response('Temporarily unavailable; retry the same identity or check status.', error);
  const discoveryParameters = [
    ...['type', 'network', 'scheme', 'payTo', 'extensions'].map((name) => ({
      name,
      in: 'query',
      schema: { type: 'string' },
      description: 'Exact-match filter within our own service catalogue.',
    })),
    { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
    { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
  ];
  return {
    openapi: '3.1.0',
    info: {
      title: 'Algoria API',
      version: '1.0.0',
      description:
        'Own service catalogue and HTTP APIs, Stellar testnet x402 payments, sync or async execution. Discovery metadata is served locally; it is not published to an external catalogue.',
    },
    servers: [{ url: config.baseUrl }],
    paths: {
      '/health': { get: { responses: { '200': response('API health', health) } } },
      '/openapi.json': {
        get: {
          responses: {
            '200': response('This API contract', {
              type: 'object',
              required: ['openapi', 'info', 'servers', 'paths', 'components'],
              properties: {
                openapi: { const: '3.1.0' },
                info: { type: 'object' },
                servers: { type: 'array' },
                paths: { type: 'object' },
                components: { type: 'object' },
              },
            }),
          },
        },
      },
      '/discovery/resources': {
        get: {
          parameters: [...discoveryParameters, { name: 'query', in: 'query', schema: { type: 'string' } }],
          responses: {
            '200': response('Own service catalogue', DISCOVERY_SCHEMA),
            '400': response('Invalid pagination', error),
            '503': unavailable,
          },
        },
      },
      '/discovery/search': {
        get: {
          parameters: [...discoveryParameters, {
            name: 'query',
            in: 'query',
            required: true,
            schema: { type: 'string', minLength: 1 },
          }],
          responses: {
            '200': response('Matching own services', DISCOVERY_SCHEMA),
            '400': response('Query required or invalid pagination', error),
            '503': unavailable,
          },
        },
      },
      '/v1/services/{service_id}': {
        parameters: [{ name: 'service_id', in: 'path', required: true, schema: { const: IMAGE_SERVICE.id } }],
        get: {
          responses: {
            '200': response('Service schema and payment requirements', SERVICE_DOCUMENT_SCHEMA),
            '404': response('Unknown service', error),
            '503': unavailable,
          },
        },
        post: {
          summary: IMAGE_SERVICE.description,
          parameters: [
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
            {
              name: 'X-Recovery-Token',
              in: 'header',
              required: true,
              schema: { type: 'string', minLength: 43, maxLength: 128 },
            },
            { name: 'PAYMENT-SIGNATURE', in: 'header', required: false, schema: { type: 'string' } },
            { name: 'mode', in: 'query', schema: { enum: ['sync', 'async'], default: 'sync' } },
            {
              name: 'wait_ms',
              in: 'query',
              schema: { type: 'integer', minimum: 0, maximum: 60000, default: 45000 },
            },
          ],
          requestBody: { required: true, content: { 'application/json': { schema: INPUT_SCHEMA } } },
          responses: {
            '200': response('Result ready', job),
            '202': response('Accepted or result delivery pending; poll the same job', job),
            '400': response('Invalid input, request identity or payment payload', error),
            '402': response('x402 payment challenge, failed verification or failed settlement', {
              anyOf: [PAYMENT_CHALLENGE_SCHEMA, error],
            }),
            '404': response('Unknown service or invalid recovery token', error),
            '409': response('Request conflict, expired quote or payment already used', error),
            '413': response('Request body too large', error),
            '415': response('JSON content type required', error),
            '429': response('Demo capacity exhausted', error),
            '502': response('Generation failed; existing job and payment receipt are returned', job),
            '503': unavailable,
          },
        },
      },
      '/v1/jobs/{job_id}': {
        get: {
          security: [{ recoveryToken: [] }],
          parameters: [{
            name: 'job_id',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          }],
          responses: {
            '200': response('Current job state, receipt and result', job),
            '404': response('Missing job or invalid recovery token', error),
            '503': unavailable,
          },
        },
      },
    },
    components: {
      schemas: {
        Job: JOB_SCHEMA,
        Error: ERROR_SCHEMA,
        Service: SERVICE_DOCUMENT_SCHEMA,
        Discovery: DISCOVERY_SCHEMA,
        PaymentChallenge: PAYMENT_CHALLENGE_SCHEMA,
      },
      securitySchemes: {
        recoveryToken: {
          type: 'http',
          scheme: 'bearer',
          description: 'The job recovery token created locally before the first request.',
        },
      },
    },
  };
}
