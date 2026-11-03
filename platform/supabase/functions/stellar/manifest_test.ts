import assert from 'node:assert/strict';
import { Ajv2020 } from 'npm:ajv@8.20.0/dist/2020.js';
import manifestSchema from 'npm:@stellar-agent-services/protocol@0.1.0/manifest.schema.json' with {
  type: 'json',
};
import { readStellarConfig, usdcToBaseUnits } from './config.ts';
import {
  buildManifest,
  EXAMPLE_NUMBER,
  PHONE_INPUT_SCHEMA,
  PHONE_OUTPUT_SCHEMA,
  PROVIDER_DESCRIPTION,
  PROVIDER_NAME,
} from './manifest.ts';
import { checkManifestRules, USDC_ASSET } from './protocol.ts';
import { type Schema, validate } from './schema.ts';
import { CONFIG, PAY_TO } from './testing.ts';

const ajv = new Ajv2020({ strict: false, allErrors: true });

Deno.test('the manifest passes the Provider Standard v1 JSON Schema and its code rules', () => {
  const manifest = buildManifest(CONFIG);
  const valid = ajv.validate(manifestSchema, manifest);
  assert.ok(valid, JSON.stringify(ajv.errors));
  assert.deepEqual(
    checkManifestRules(manifest, {
      manifestUrl: CONFIG.manifestUrl,
      validateExample: (schema, value) => ajv.validate(schema, value) as boolean,
    }),
    [],
  );
  assert.equal(manifest.payment.accepts[0].network, 'stellar:pubnet');
  assert.equal(manifest.payment.accepts[0].asset, USDC_ASSET['stellar:pubnet']);
  assert.equal(manifest.payment.accepts.length, 1);
  assert.equal('amount' in manifest.payment.accepts[0], false, '[P1] the price lives on the service');
  assert.equal(manifest.services[0].price.amount, '10000000', '1 USDC, 7 decimals');
  assert.equal(manifest.services[0].charge, 'upfront');
  assert.equal(manifest.provider.agentId, 7);
  assert.ok(!/https?:|\$|usdc\b|\d+ ?usdc/i.test(manifest.services[0].description), '§3.4 no price or URL');
});

Deno.test('search on mainnet finds the provider by its service words', () => {
  // Stellar Agent Search reads only the registration's name and description on mainnet, which
  // provider-kit launch publishes from provider.name and provider.description.
  const text = `${PROVIDER_NAME} ${PROVIDER_DESCRIPTION}`.toLowerCase();
  const service = buildManifest(CONFIG).services[0];
  const words = [service.name, service.title ?? '', ...(service.tags ?? [])]
    .flatMap((value) => value.toLowerCase().split(/[^a-z0-9]+/))
    .filter((word) => word.length > 1);
  for (const word of words) {
    assert.ok(text.includes(word.slice(0, 5)), `"${word}" is missing from the description`);
  }
  assert.ok(PROVIDER_DESCRIPTION.length <= 500);
});

Deno.test('the schema validator agrees with Ajv on inputs and outputs', () => {
  const example = buildManifest(CONFIG).services[0].examples![0];
  const inputs: unknown[] = [
    example.input,
    { to: EXAMPLE_NUMBER, goal: 'Ask about opening hours.', on_behalf_of: 'Sam' },
    { to: EXAMPLE_NUMBER, goal: 'Hi', on_behalf_of: 'Sam' },
    { to: '05551112233', goal: 'Ask about opening hours.', on_behalf_of: 'Sam' },
    { to: EXAMPLE_NUMBER, goal: 'Ask about opening hours.' },
    { to: EXAMPLE_NUMBER, goal: 'Ask about opening hours.', on_behalf_of: 'Sam', language: 'de' },
    { to: EXAMPLE_NUMBER, goal: 'Ask about opening hours.', on_behalf_of: 'Sam', extra: true },
    { to: 14155550123, goal: 'x'.repeat(501), on_behalf_of: '' },
    { to: EXAMPLE_NUMBER, goal: 'Ask about opening hours.', on_behalf_of: '😀'.repeat(80) },
    { to: EXAMPLE_NUMBER, goal: 'Ask about opening hours.', on_behalf_of: '😀'.repeat(81) },
    [],
    'text',
  ];
  for (const input of inputs) {
    assert.equal(
      validate(PHONE_INPUT_SCHEMA, input).length === 0,
      ajv.validate(PHONE_INPUT_SCHEMA, input),
      JSON.stringify(input).slice(0, 80),
    );
  }
  const outputs: unknown[] = [
    example.output,
    {
      call: {
        status: 'no-answer',
        connected: false,
        summary: 'Nobody answered.',
        goal_achieved: false,
        transcript: [],
      },
    },
    { call: { status: 'ringing', connected: false, summary: '', goal_achieved: false, transcript: [] } },
    {
      call: {
        status: 'completed',
        connected: true,
        summary: '',
        goal_achieved: true,
        transcript: [{ speaker: 'x', text: '' }],
      },
    },
    {
      call: {
        status: 'completed',
        connected: true,
        summary: '',
        goal_achieved: true,
        transcript: [],
        duration_seconds: -1,
      },
    },
    { call: { status: 'completed', connected: true, summary: '', transcript: [] } },
  ];
  for (const output of outputs) {
    assert.equal(
      validate(PHONE_OUTPUT_SCHEMA, output).length === 0,
      ajv.validate(PHONE_OUTPUT_SCHEMA, output),
    );
  }
  assert.deepEqual(
    validate(PHONE_INPUT_SCHEMA as Schema, { to: 'x', goal: 'Ask.', on_behalf_of: 'Sam', more: 1 }),
    [
      { pointer: '/to', message: 'does not have the required format' },
      { pointer: '/more', message: 'is not an allowed property' },
    ],
  );
});

Deno.test('configuration fails closed on anything that touches money', () => {
  const env: Record<string, string> = {
    STELLAR_NETWORK: 'mainnet',
    STELLAR_PAY_TO: PAY_TO,
    STELLAR_FACILITATOR_AUTH: 'Bearer key',
    SUPABASE_URL: 'https://ref.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role',
    TWILIO_ACCOUNT_SID: 'AC1',
    TWILIO_AUTH_TOKEN: 'token',
    TWILIO_FROM_NUMBER: '+15550001111',
    OPENAI_API_KEY: 'sk',
  };
  const read = (overrides: Record<string, string | undefined> = {}) =>
    readStellarConfig((name) => (name in overrides ? overrides[name] : env[name]));
  const config = read();
  assert.equal(config.network, 'stellar:pubnet');
  assert.equal(config.facilitatorUrl, 'https://channels.openzeppelin.com/x402');
  assert.deepEqual(config.facilitatorHeaders, { Authorization: 'Bearer key' });
  assert.equal(config.rpcUrl, 'https://mainnet.sorobanrpc.com');
  assert.equal(config.baseUrl, 'https://ref.supabase.co/functions/v1/stellar');
  assert.equal(config.priceAmount, '10000000');
  assert.throws(() => read({ STELLAR_NETWORK: undefined }), /STELLAR_NETWORK/);
  assert.throws(() => read({ STELLAR_FACILITATOR_AUTH: undefined }), /STELLAR_FACILITATOR_AUTH/);
  assert.throws(() => read({ STELLAR_PAY_TO: 'SB' + 'A'.repeat(54) }), /STELLAR_PAY_TO/);
  assert.throws(() => read({ STELLAR_PAY_TO: undefined }), /STELLAR_PAY_TO/);
  assert.throws(() => read({ STELLAR_PHONE_PRICE_USDC: '0' }), /PRICE/);
  assert.throws(() => read({ STELLAR_FACILITATOR_URL: 'http://facilitator.example' }), /https/);
  assert.equal(
    read({ STELLAR_NETWORK: 'testnet', STELLAR_FACILITATOR_AUTH: undefined }).facilitatorUrl,
    'https://www.x402.org/facilitator',
  );
  assert.equal(usdcToBaseUnits('1'), '10000000');
  assert.equal(usdcToBaseUnits('0.5'), '5000000');
  assert.equal(usdcToBaseUnits('2.0000001'), '20000001');
  assert.throws(() => usdcToBaseUnits('1.00000001'));
});
