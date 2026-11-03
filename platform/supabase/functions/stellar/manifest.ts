// The provider's manifest (§2): who it is, how it is paid and its one service, `phone-call`.
//
// Stellar Agent Search matches a query against the 8004 registration, which `provider-kit launch`
// publishes from provider.name and provider.description. On mainnet those two fields are all it reads,
// so they carry the words agents search for: phone, call, voice, appointment, reservation, reminder.
// Descriptions say what the service does, when to use it and its limits, with no price, URL or
// instruction to the agent (§3.4).

import type { StellarConfig } from './config.ts';
import { PROVIDER_STANDARD, type ProviderManifest, type ServiceDescriptor } from './protocol.ts';
import type { Schema } from './schema.ts';

export const PHONE_SERVICE = 'phone-call';

export const PROVIDER_NAME = 'Algoria AI Phone Calls';
export const PROVIDER_DESCRIPTION =
  'AI phone calls for agents, paid in USDC on Stellar. Give any phone number and a goal: a realtime AI voice ' +
  'calls it, talks for you in English or Turkish, and returns the transcript, a summary and whether the goal ' +
  'was achieved. Use it to call a business, book or confirm an appointment, make a reservation, deliver a ' +
  'reminder or ask a question by phone.';

export const PHONE_INPUT_SCHEMA: Schema = {
  type: 'object',
  required: ['to', 'goal', 'on_behalf_of'],
  additionalProperties: false,
  properties: {
    to: {
      type: 'string',
      title: 'Phone number',
      description:
        'The number to call, in E.164 format: a plus sign, the country code and the number, such as +14155550123.',
      pattern: '^\\+[1-9][0-9]{6,14}$',
    },
    goal: {
      type: 'string',
      title: 'Goal',
      description: 'What the call should achieve, in one or two plain sentences.',
      minLength: 3,
      maxLength: 500,
    },
    on_behalf_of: {
      type: 'string',
      title: 'On behalf of',
      description:
        'Who the assistant calls for. It introduces itself as an AI assistant calling on their behalf.',
      minLength: 1,
      maxLength: 80,
    },
    callee_name: {
      type: 'string',
      title: 'Callee name',
      description: 'Name of the person or business being called, if known.',
      minLength: 1,
      maxLength: 80,
    },
    language: {
      type: 'string',
      title: 'Language',
      description: 'Language of the call: en (English, the default) or tr (Turkish).',
      enum: ['en', 'tr'],
      default: 'en',
    },
  },
};

export const CALL_STATUSES = ['completed', 'busy', 'no-answer', 'failed', 'canceled'] as const;

export const PHONE_OUTPUT_SCHEMA: Schema = {
  type: 'object',
  required: ['call'],
  additionalProperties: false,
  properties: {
    call: {
      type: 'object',
      required: ['status', 'connected', 'summary', 'goal_achieved', 'transcript'],
      additionalProperties: false,
      properties: {
        status: {
          type: 'string',
          description: 'How the call ended: completed, busy, no-answer, failed or canceled.',
          enum: [...CALL_STATUSES],
        },
        connected: { type: 'boolean', description: 'Whether someone (or a voicemail) answered.' },
        duration_seconds: { type: 'integer', minimum: 0, description: 'Billed call length in seconds.' },
        summary: { type: 'string', description: 'What was said and agreed, in one to three sentences.' },
        goal_achieved: { type: 'boolean', description: 'Whether the goal was achieved.' },
        transcript: {
          type: 'array',
          maxItems: 200,
          items: {
            type: 'object',
            required: ['speaker', 'text'],
            additionalProperties: false,
            properties: {
              speaker: { type: 'string', enum: ['agent', 'contact'] },
              text: { type: 'string' },
            },
          },
        },
      },
    },
  },
};

/** E.164 number reserved for fiction (NANP 555-0100 to 0199): an example nobody answers. */
export const EXAMPLE_NUMBER = '+14155550123';

const EXAMPLE = {
  input: {
    to: EXAMPLE_NUMBER,
    goal:
      'Confirm the table for two at 7 pm tonight under the name Rivera, and ask whether they have a terrace.',
    on_behalf_of: 'Alex Rivera',
    callee_name: 'Luna Bistro',
    language: 'en',
  },
  output: {
    call: {
      status: 'completed',
      connected: true,
      duration_seconds: 41,
      summary:
        'The restaurant confirmed the table for two at 7 pm under Rivera and said the terrace is open tonight.',
      goal_achieved: true,
      transcript: [
        {
          speaker: 'agent',
          text:
            "Hi, I'm an AI assistant calling on behalf of Alex Rivera to confirm a table for two at 7 tonight.",
        },
        { speaker: 'contact', text: "Yes, I see it, two at seven under Rivera. You're all set." },
        { speaker: 'agent', text: 'Great, thank you. Do you have a terrace open tonight?' },
        { speaker: 'contact', text: 'We do, I can put you outside.' },
        { speaker: 'agent', text: 'Perfect, thanks so much. Goodbye!' },
      ],
    },
  },
};

export function phoneService(config: StellarConfig): ServiceDescriptor {
  return {
    name: PHONE_SERVICE,
    title: 'AI phone call',
    description:
      'Places one real outbound phone call to any number and lets a realtime AI voice assistant hold a short ' +
      'conversation to reach the goal you give, such as confirming an appointment, asking a business a question ' +
      'or delivering a reminder. The assistant says it is an AI calling on behalf of the name you give, speaks ' +
      'English or Turkish, and hangs up when the goal is reached, when the person declines, or after about 90 ' +
      'seconds. Returns how the call ended, whether someone answered, the transcript, a short summary and whether ' +
      'the goal was achieved. Numbers must be in E.164 format. Premium-rate numbers, numbers that asked not to be ' +
      'called again and repeated calls to one number are refused. The assistant will not threaten, pressure or ' +
      'ask for passwords, codes or payment details. A busy or unanswered call still counts as a call.',
    price: { amount: config.priceAmount },
    charge: 'upfront',
    expectedDurationSeconds: 120,
    maxInputBytes: 4096,
    tags: [
      'phone',
      'phone-call',
      'call',
      'voice',
      'ai-agent',
      'appointment',
      'reservation',
      'reminder',
      'turkish',
    ],
    capacity: { concurrency: config.concurrency, maxQueueWaitSeconds: 0 },
    inputSchema: PHONE_INPUT_SCHEMA as ServiceDescriptor['inputSchema'],
    outputSchema: PHONE_OUTPUT_SCHEMA as ServiceDescriptor['outputSchema'],
    examples: [EXAMPLE as unknown as NonNullable<ServiceDescriptor['examples']>[number]],
  };
}

export function buildManifest(config: StellarConfig): ProviderManifest {
  return {
    standard: PROVIDER_STANDARD,
    provider: {
      name: PROVIDER_NAME,
      description: PROVIDER_DESCRIPTION,
      ...(config.agentId === undefined ? {} : { agentId: config.agentId }),
      // Inputs and transcripts are kept until the job's retention ends, then deleted.
      dataUse: { storesInputs: false, trainsOnInputs: false },
    },
    baseUrl: config.baseUrl,
    payment: {
      protocol: 'x402',
      x402Version: 2,
      accepts: [{
        scheme: 'exact',
        network: config.network,
        asset: config.asset,
        payTo: config.payTo,
        maxTimeoutSeconds: config.maxTimeoutSeconds,
        extra: { areFeesSponsored: true },
      }],
    },
    jobs: { retentionSeconds: config.retentionSeconds },
    services: [phoneService(config)],
  } as ProviderManifest;
}
