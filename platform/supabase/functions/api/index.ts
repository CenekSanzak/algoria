import { createApp } from './app.ts';
import { readConfig } from './config.ts';
import { Store } from './store.ts';
import { PaymentGateway } from './payments.ts';
import { FalProvider } from './fal.ts';
import { SupabaseArtifacts } from './artifacts.ts';

const config = readConfig();
const app = createApp({
  config,
  store: new Store(config.supabaseUrl, config.serviceRoleKey),
  payments: new PaymentGateway(config.facilitatorUrl),
  fal: new FalProvider(config.falKey),
  artifacts: new SupabaseArtifacts(config),
});
Deno.serve(app.fetch);
