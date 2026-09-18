import type { Config } from './config.ts';
import { enabledServices, IMAGE_SERVICE, LEGACY_COMPOSE_SERVICE, type Service, SERVICES } from './catalog.ts';
export { IMAGE_SERVICE, INPUT_SCHEMA } from './catalog.ts';

export const MODES = {
  supported: ['sync', 'async'],
  default: 'sync',
  default_wait_ms: 45000,
  max_wait_ms: 60000,
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
const MEDIA_PROPERTIES = {
  url: { type: 'string', format: 'uri' },
  file_size: { type: 'integer', minimum: 0 },
  duration: { type: 'number', exclusiveMinimum: 0, description: 'Media duration in seconds.' },
};
function mediaSchema(kind: Service['outputKind']) {
  return {
    type: 'object',
    required: ['url', 'content_type'],
    additionalProperties: false,
    properties: {
      ...MEDIA_PROPERTIES,
      content_type: {
        enum: kind === 'images'
          ? ['image/png', 'image/jpeg', 'image/webp']
          : kind === 'audio'
          ? ['audio/wav', 'audio/mpeg']
          : ['video/mp4'],
      },
      ...(kind !== 'audio'
        ? { width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 } }
        : {}),
    },
  };
}
function outputSchema(kind: Service['outputKind']) {
  const media = mediaSchema(kind);
  return {
    type: 'object',
    required: [kind, 'url_expires_in'],
    additionalProperties: false,
    properties: {
      [kind]: kind === 'images' ? { type: 'array', minItems: 1, maxItems: 1, items: media } : media,
      url_expires_in: {
        type: 'integer',
        minimum: 1,
        description: 'Signed media URL lifetime in seconds.',
      },
    },
  };
}
function jobSchema(services: Service[]) {
  const kinds = [...new Set(services.map((service) => service.outputKind))];
  return {
    type: 'object',
    required: [
      'job_id',
      'service_id',
      'service_version',
      'status',
      'status_url',
      'payment',
      'output',
      'error',
    ],
    properties: {
      job_id: { type: 'string', format: 'uuid' },
      service_id: services.length === 1
        ? { const: services[0].id }
        : { enum: [...new Set(services.map((s) => s.id))] },
      service_version: services.length === 1
        ? { const: services[0].version }
        : { enum: [...new Set(services.map((s) => s.version))] },
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
      output: nullable(kinds.length === 1 ? outputSchema(kinds[0]) : { oneOf: kinds.map(outputSchema) }),
      error: nullable(ERROR_SCHEMA),
      message: { type: 'string' },
    },
    ...(services.length > 1
      ? {
        oneOf: services.map((service) => ({
          properties: { service_id: { const: service.id }, service_version: { const: service.version } },
        })),
      }
      : {}),
    additionalProperties: false,
  };
}
export const JOB_SCHEMA = jobSchema([...SERVICES, LEGACY_COMPOSE_SERVICE]);
export const jobSchemaFor = (service: Service) => jobSchema([service]);

const exampleId = '00000000-0000-4000-8000-000000000001';
function exampleOutput(service: Service) {
  const media = service.outputKind === 'images'
    ? {
      url: 'https://storage.example.com/image.png?token=example',
      content_type: 'image/png',
      width: 1024,
      height: 1024,
    }
    : service.outputKind === 'audio'
    ? {
      url: 'https://storage.example.com/audio.wav?token=example',
      content_type: 'audio/wav',
      file_size: 960044,
      duration: 20,
    }
    : {
      url: 'https://storage.example.com/video.mp4?token=example',
      content_type: 'video/mp4',
      width: 1024,
      height: 1024,
      file_size: 1500000,
      duration: 20,
    };
  return {
    [service.outputKind]: service.outputKind === 'images' ? [media] : media,
    url_expires_in: 3600,
  };
}
export function bazaarFor(service: Service) {
  return {
    info: {
      input: {
        type: 'http',
        method: 'POST',
        bodyType: 'json',
        body: service.exampleInput,
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
          service_id: service.id,
          service_version: service.version,
          status: 'succeeded',
          status_url: `https://api.example.com/v1/jobs/${exampleId}`,
          payment: { success: true, network: 'stellar:testnet', transaction: '0'.repeat(64) },
          output: exampleOutput(service),
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
            body: service.inputSchema,
            queryParams: {
              type: 'object',
              properties: { mode: { enum: ['sync', 'async'] }, wait_ms: { type: 'string' } },
            },
            headers: { type: 'object', additionalProperties: { type: 'string' } },
          },
        },
        output: {
          type: 'object',
          properties: { type: { const: 'json' }, example: jobSchemaFor(service) },
          required: ['type'],
        },
      },
    },
  };
}
export const BAZAAR = bazaarFor(IMAGE_SERVICE);

export function serviceDocument(config: Config, requirements: unknown, service: Service = IMAGE_SERVICE) {
  return {
    id: service.id,
    version: service.version,
    name: service.name,
    description: service.description,
    tags: service.tags,
    type: 'http',
    x402Version: 2,
    resource: `${config.baseUrl}/v1/services/${service.id}`,
    method: 'POST',
    input_schema: service.inputSchema,
    output_schema: jobSchemaFor(service),
    execution: MODES,
    accepts: [requirements],
    extensions: { bazaar: bazaarFor(service) },
    headers: {
      'Idempotency-Key': 'Required UUID v4; preserve it on retries.',
      'X-Recovery-Token': 'Required random 32-byte base64url secret; preserve locally. Never put in a URL.',
      'PAYMENT-SIGNATURE': 'Standard x402 v2 payment authorization, after receiving 402.',
    },
    responses: {
      '200': 'Completed result and payment receipt',
      '202': 'Same job continues; poll status_url with recovery token',
      '402': 'Payment required; no service execution started',
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
    id: { enum: SERVICES.map((service) => service.id) },
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
  const services = enabledServices(config);
  const serviceSchema = {
    ...SERVICE_DOCUMENT_SCHEMA,
    additionalProperties: false,
    properties: { ...SERVICE_DOCUMENT_SCHEMA.properties, id: { enum: services.map((s) => s.id) } },
    oneOf: services.map((service) => ({
      properties: { id: { const: service.id }, version: { const: service.version } },
    })),
  };
  const discoverySchema = {
    ...DISCOVERY_SCHEMA,
    properties: {
      ...DISCOVERY_SCHEMA.properties,
      resources: { type: 'array', items: serviceSchema },
    },
  };
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
  const document = {
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
            '200': response('Own service catalogue', discoverySchema),
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
            '200': response('Matching own services', discoverySchema),
            '400': response('Query required or invalid pagination', error),
            '503': unavailable,
          },
        },
      },
      '/v1/services/{service_id}': {
        parameters: [{
          name: 'service_id',
          in: 'path',
          required: true,
          schema: { enum: services.map((service) => service.id) },
        }],
        get: {
          responses: {
            '200': response('Service schema and payment requirements', serviceSchema),
            '404': response('Unknown service', error),
            '503': unavailable,
          },
        },
        post: {
          summary: 'Execute an enabled service; use its dedicated path for the exact input schema.',
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
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { anyOf: services.map((service) => service.inputSchema) },
                examples: Object.fromEntries(
                  services.map((service) => [service.id, { value: service.exampleInput }]),
                ),
              },
            },
          },
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
        Service: serviceSchema,
        Discovery: discoverySchema,
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
  const generic = document.paths['/v1/services/{service_id}'];
  const specificPaths = Object.fromEntries(services.map((service) => {
    const specificJob = jobSchemaFor(service);
    return [`/v1/services/${service.id}`, {
      get: {
        ...generic.get,
        responses: {
          ...generic.get.responses,
          '200': response('Service schema and payment requirements', {
            ...serviceSchema,
            properties: {
              ...serviceSchema.properties,
              id: { const: service.id },
              version: { const: service.version },
            },
          }),
        },
      },
      post: {
        ...generic.post,
        operationId: service.id.replaceAll('.', '_'),
        summary: service.description,
        requestBody: {
          required: true,
          content: { 'application/json': { schema: service.inputSchema, example: service.exampleInput } },
        },
        responses: {
          ...generic.post.responses,
          '200': response('Result ready', specificJob),
          '202': response('Accepted or result delivery pending; poll the same job', specificJob),
          '502': response('Service failed; existing job and payment receipt are returned', specificJob),
        },
      },
    }];
  }));
  return { ...document, paths: { ...document.paths, ...specificPaths } };
}
