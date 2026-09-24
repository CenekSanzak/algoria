export interface Config {
  supabaseUrl: string;
  serviceRoleKey: string;
  falKey: string;
  imagePayTo: string;
  baseUrl: string;
  facilitatorUrl: string;
  priceAtomic: string;
  servicePayments?: Record<string, { payTo: string; priceAtomic: string }>;
  phone?: PhoneConfig;
}
export interface PhoneConfig {
  accountSid: string;
  authToken: string;
  from: string;
  openaiKey: string;
  realtimeModel: string;
  voice: string;
  /** Contact name -> E.164 number. Only these can be called. */
  contacts: Record<string, string>;
}

function readPhoneConfig(): PhoneConfig | undefined {
  const accountSid = Deno.env.get('TWILIO_ACCOUNT_SID');
  const authToken = Deno.env.get('TWILIO_AUTH_TOKEN');
  const from = Deno.env.get('TWILIO_FROM_NUMBER');
  const openaiKey = Deno.env.get('OPENAI_API_KEY');
  const rawContacts = Deno.env.get('PHONE_CALL_CONTACTS');
  if (!accountSid || !authToken || !from || !openaiKey || !rawContacts) return undefined;
  return {
    accountSid,
    authToken,
    from,
    openaiKey,
    realtimeModel: Deno.env.get('PHONE_CALL_REALTIME_MODEL') || 'gpt-realtime-mini',
    voice: Deno.env.get('PHONE_CALL_VOICE') || 'marin',
    contacts: parseContacts(rawContacts),
  };
}

/** `{"berkin":"+905551112233"}` -> validated lowercase names and E.164 numbers. */
export function parseContacts(raw: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('PHONE_CALL_CONTACTS must be JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('PHONE_CALL_CONTACTS must be a JSON object');
  }
  const contacts: Record<string, string> = {};
  for (const [name, number] of Object.entries(parsed)) {
    const key = name.trim().toLowerCase();
    if (
      !/^[a-z][a-z0-9_-]{0,31}$/.test(key) || typeof number !== 'string' ||
      !/^\+[1-9][0-9]{6,14}$/.test(number)
    ) {
      throw new Error('Invalid PHONE_CALL_CONTACTS entry');
    }
    contacts[key] = number;
  }
  if (!Object.keys(contacts).length) throw new Error('PHONE_CALL_CONTACTS is empty');
  return contacts;
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
  const servicePayments: NonNullable<Config['servicePayments']> = {};
  const phone = readPhoneConfig();
  const recipients = new Set([imagePayTo]);
  for (
    const [id, prefix, defaultPrice] of [
      ['video.social', 'VIDEO_SOCIAL', '1100000'],
      ['speech.generate', 'SPEECH_GENERATE', '200000'],
      ['video.slideshow', 'VIDEO_SLIDESHOW', '100000'],
      ['video.compose', 'VIDEO_COMPOSE', '100000'],
      ['video.caption', 'VIDEO_CAPTION', '200000'],
      ['phone.call', 'PHONE_CALL', '1000000'],
    ]
  ) {
    const payTo = Deno.env.get(`${prefix}_PAY_TO`);
    if (!payTo) continue;
    // The phone service is listed only when Twilio/OpenAI are configured too.
    if (id === 'phone.call' && !phone) continue;
    const price = Deno.env.get(`${prefix}_PRICE_ATOMIC`) ?? defaultPrice;
    if (!/^G[A-Z2-7]{55}$/.test(payTo) || recipients.has(payTo)) {
      throw new Error(`${id} requires its own valid recipient`);
    }
    if (!/^[1-9][0-9]{0,8}$/.test(price)) throw new Error(`Invalid ${id} price`);
    servicePayments[id] = { payTo, priceAtomic: price };
    recipients.add(payTo);
  }
  return {
    supabaseUrl,
    // Injected SUPABASE_SERVICE_ROLE_KEY can carry a future `iat` after platform key changes, which
    // PostgREST rejects ("JWT issued at future"); an explicitly deployed copy takes precedence.
    serviceRoleKey: Deno.env.get('ALGORIA_SERVICE_ROLE_KEY') || required('SUPABASE_SERVICE_ROLE_KEY'),
    falKey: required('FAL_KEY'),
    imagePayTo,
    baseUrl: (Deno.env.get('ALGORIA_API_BASE_URL') || `${supabaseUrl}/functions/v1/api`).replace(/\/$/, ''),
    facilitatorUrl: Deno.env.get('FACILITATOR_URL') || 'https://www.x402.org/facilitator',
    priceAtomic,
    servicePayments,
    phone,
  };
}
