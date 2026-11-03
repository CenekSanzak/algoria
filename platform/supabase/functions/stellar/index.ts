// Algoria's Stellar Agent Services provider: AI phone calls paid in USDC on Stellar, under Provider
// Standard v1. Deployed as the `stellar` Supabase Edge Function next to the demo API (`api`).
//
// The manifest is checked against the standard's code rules before the server starts, so a provider
// that would break the standard never takes a payment.

import { openAiSummarizer, SupabaseCallRepository, Twilio } from '../api/phone.ts';
import { createProvider } from './app.ts';
import { readStellarConfig } from './config.ts';
import { buildManifest } from './manifest.ts';
import { rpcChain } from './onchain.ts';
import { PhoneCallService, twilioDirectory } from './phone.ts';
import { checkManifestRules } from './protocol.ts';
import { type Schema, validate } from './schema.ts';
import { supabaseJobStore } from './store.ts';
import { httpFacilitator } from './x402.ts';

const config = readStellarConfig();
const manifest = buildManifest(config);
const violations = checkManifestRules(manifest, {
  manifestUrl: config.manifestUrl,
  validateExample: (schema, value) => validate(schema as Schema, value).length === 0,
});
if (violations.length) {
  throw new Error(
    `The manifest breaks Provider Standard v1: ${violations.map((v) => `${v.rule} ${v.pointer}`).join(', ')}`,
  );
}

const waitUntil = (work: Promise<unknown>) =>
  (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime?.waitUntil(work);
const store = supabaseJobStore(config.supabaseUrl, config.serviceRoleKey);
const phone = new PhoneCallService({
  config: config.phone,
  store,
  calls: new SupabaseCallRepository(config.supabaseUrl, config.serviceRoleKey, 'stellar_phone_calls'),
  twilio: new Twilio(config.phone),
  directory: twilioDirectory(config.phone),
  summarize: openAiSummarizer(config.phone.openaiKey),
  baseUrl: config.baseUrl,
});
const provider = createProvider({
  config,
  manifest,
  store,
  facilitator: httpFacilitator(config.facilitatorUrl, { headers: config.facilitatorHeaders }),
  phone,
  chain: rpcChain(config.rpcUrl),
  waitUntil,
});
console.log('stellar provider ready', config.network, config.manifestUrl);
Deno.serve(provider.fetch);
