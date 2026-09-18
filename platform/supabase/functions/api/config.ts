export interface Config {
  supabaseUrl: string;
  serviceRoleKey: string;
  falKey: string;
  imagePayTo: string;
  baseUrl: string;
  facilitatorUrl: string;
  priceAtomic: string;
}

export function readConfig(): Config {
  function required(name: string) {
    const value = Deno.env.get(name);
    if (!value) throw new Error(`Missing configuration: ${name}`);
    return value;
  }
  const supabaseUrl = required('SUPABASE_URL');
  const imagePayTo = required('IMAGE_GENERATE_PAY_TO');
  if (!/^G[A-Z2-7]{55}$/.test(imagePayTo)) throw new Error('Invalid image service recipient');
  const priceAtomic = Deno.env.get('IMAGE_GENERATE_PRICE_ATOMIC') ?? '100000';
  if (!/^[1-9][0-9]{0,8}$/.test(priceAtomic)) throw new Error('Invalid service price');
  return {
    supabaseUrl,
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
    falKey: required('FAL_KEY'),
    imagePayTo,
    baseUrl: (Deno.env.get('ALGORIA_API_BASE_URL') || `${supabaseUrl}/functions/v1/api`).replace(/\/$/, ''),
    facilitatorUrl: Deno.env.get('FACILITATOR_URL') || 'https://www.x402.org/facilitator',
    priceAtomic,
  };
}
