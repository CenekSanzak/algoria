import { SocialWorkflow } from './social.ts';
import { SocialStore } from './social-store.ts';
import { createApp } from './app.ts';
import { readConfig } from './config.ts';
import { Store } from './store.ts';
import { PaymentGateway } from './payments.ts';
import { FalProvider } from './fal.ts';
import { SupabaseArtifacts } from './artifacts.ts';
import { openAiSummarizer, PhoneCalls, SupabaseCallRepository, Twilio } from './phone.ts';

const config = readConfig();
const store = new Store(config.supabaseUrl, config.serviceRoleKey);
const repository = new SocialStore(config.supabaseUrl, config.serviceRoleKey);
const fal = new FalProvider(config.falKey);
const artifacts = new SupabaseArtifacts(config);
const social = new SocialWorkflow({
  store,
  repository,
  fal,
  artifacts,
  baseUrl: config.baseUrl,
  supabaseUrl: config.supabaseUrl,
});
const phone = config.phone
  ? new PhoneCalls({
    config: config.phone,
    store,
    calls: new SupabaseCallRepository(config.supabaseUrl, config.serviceRoleKey),
    twilio: new Twilio(config.phone),
    baseUrl: config.baseUrl,
    summarize: openAiSummarizer(config.phone.openaiKey),
  })
  : undefined;
const app = createApp({
  phone,
  config,
  store,
  fal,
  artifacts,
  social,
  references: repository,
  workflowSecret: Deno.env.get('SOCIAL_WORKFLOW_SECRET'),
  payments: new PaymentGateway(config.facilitatorUrl),
});
Deno.serve(app.fetch);
