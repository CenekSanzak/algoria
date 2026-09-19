import { SocialWorkflow } from './social.ts';
import { SocialStore } from './social-store.ts';
import { createApp } from './app.ts';
import { readConfig } from './config.ts';
import { Store } from './store.ts';
import { PaymentGateway } from './payments.ts';
import { FalProvider } from './fal.ts';
import { SupabaseArtifacts } from './artifacts.ts';

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
const app = createApp({
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
