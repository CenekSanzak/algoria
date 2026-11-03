# Stellar Agent Services provider: AI phone calls on mainnet

`supabase/functions/stellar` sells one service, `phone-call`, to any AI agent: a real outbound call to any
phone number, held by a realtime AI voice, for **1 USDC on Stellar mainnet**. It follows
[Provider Standard v1](https://github.com/AlgoriaLabs/stellar-agent-services/blob/main/docs/provider-standard.md)
(`stellar-agent-services/provider@1`), so any client of the standard can find it, pay it and recover its jobs,
and it registers in the Stellar 8004 registry, so
[Stellar Agent Search](https://github.com/berkingurcan/stellar-agent-search) finds it.

It runs as its own Edge Function in the same Supabase project as the demo API (`api`), next to it. The demo
API, its testnet services and its tables are unchanged. The voice bridge (Twilio Media Streams to OpenAI
Realtime) is the demo API's, in `functions/api/phone.ts`.

|                |                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| Manifest       | `https://vqqbvydiehuwdzbgvmun.supabase.co/functions/v1/stellar/.well-known/stellar-agent-services.json` |
| Create a job   | `POST {baseUrl}/services/phone-call/jobs`, paid with x402 v2 `exact` in USDC                            |
| Check status   | `GET {baseUrl}/jobs/{jobId}` with `Job-Token`                                                           |
| Get the result | `GET {baseUrl}/jobs/{jobId}/result` with `Job-Token`                                                    |
| Network        | `stellar:pubnet`, USDC `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75`                       |
| Facilitator    | OpenZeppelin, `https://channels.openzeppelin.com/x402`, with an API key                                 |
| Price          | `10000000` base units = 1 USDC, `charge: "upfront"`                                                     |

## The service

Input:

```json
{
  "to": "+14155550123",
  "goal": "Confirm the table for two at 7 pm tonight under the name Rivera.",
  "on_behalf_of": "Alex Rivera",
  "callee_name": "Luna Bistro",
  "language": "en"
}
```

`to` is any E.164 number. `language` is `en` (default) or `tr`. The assistant says it is an AI calling on
behalf of `on_behalf_of`, pursues the goal for about 90 seconds at most, and hangs up.

Output, once the call is over:

```json
{
  "call": {
    "status": "completed",
    "connected": true,
    "duration_seconds": 41,
    "summary": "The restaurant confirmed the table for two at 7 pm.",
    "goal_achieved": true,
    "transcript": [
      { "speaker": "agent", "text": "Hi, I'm an AI assistant calling on behalf of Alex Rivera..." }
    ]
  }
}
```

A busy or unanswered call is a finished job too, with `connected: false` and `status` `busy`, `no-answer`,
`failed` or `canceled`. It was charged: the charge is `upfront`, as the manifest says.

## Calling anyone, safely

Anyone can pay and any number can be called, so these checks run **before the 402**: nobody pays for a call
that can't be placed.

- The number is a real number (libphonenumber, offline), not premium-rate or shared-cost, and not the
  provider's own.
- Its owner did not opt out. On a call, the assistant has an `opt_out` tool: if the person asks not to be
  called again, the number goes on a do-not-call list (`stellar_phone_optouts`, a hash of the number) and is
  refused from then on.
- One call to a number at a time, and at most `STELLAR_PHONE_CALLS_PER_NUMBER` (3) a day: `429` with
  `Retry-After`.
- At most `STELLAR_PHONE_CONCURRENCY` (2) calls at once: `503` with `Retry-After`.
- Twilio may call the number's country (Voice geographic permissions), and a trial account calls only its
  verified numbers. These lookups are cached and fail open: a definite "no" refuses, a Twilio outage does not.

The assistant's instructions carry rules the paid goal can't change: it says it is an AI, never threatens or
pressures, and never asks for payments, transfers, passwords, codes, PINs, card or bank details or ID numbers.

Twilio must be an upgraded (paid) account with Voice geographic permissions for every country you want to
reach.

## Money rules

Ported from the Provider Kit (`@stellar-agent-services/provider-kit` 0.1.0, MIT) and kept as the kit keeps
them:

- The provider holds no Stellar secret key: only its public `payTo` and the facilitator's API key.
- A payment is checked locally before the facilitator sees it: one USDC `transfer(payer, payTo, 1 USDC)`
  signed by the payer, and nothing else. One signed payment buys one job [P9]. A job id is bound to one input
  and one token [J4]; repeating the request returns the same job and never settles again [J5].
- A settlement nobody can decide is `payment_uncertain`, never `failed` and never charged again. It is decided
  from the chain: the transaction that carries the payer's signed auth entry with the job's nonce is the
  payment [J13]. A payment that provably never landed fails the job uncharged.
- The dial is claimed once and never repeated, even when Twilio's answer was lost: the phone may be ringing.

Supabase runs code only while a request does, so a job moves on whatever reaches it first: a Twilio status
callback, the voice bridge, a client's status request, or the minute sweep (`pg_cron` calls
`/internal/sweep`), which also decides uncertain payments from the chain and deletes finished jobs after 24
hours [J15].

## Deploy

From `platform/`, on a computer logged in to the Supabase CLI (`npx supabase login`):

```sh
node scripts/stellar-deploy.mjs
```

It asks once for:

1. **The payout address**: a G... account of yours that receives the USDC. It needs a few XLM for the USDC
   trustline and the registration fee.
2. **OpenZeppelin's mainnet facilitator API key**, from
   [channels.openzeppelin.com/gen](https://channels.openzeppelin.com/gen) (GitHub sign-in). It is typed into
   your terminal, hidden, and kept only in `.env.local` and Supabase secrets.

Then it applies the migration with migration history, schedules the sweep (its secret in Vault), sets the
`STELLAR_*` secrets, deploys the function and waits for the manifest. Next, `provider-kit launch` opens a page
in your browser: connect the payout account in your wallet (Freighter, xBull, Albedo, ...) and approve the
USDC trustline and the Stellar 8004 registration. The script saves the agent id, deploys again so the manifest
names it [I2], and runs `provider-kit check` and `verifier check` against the live manifest.

Each step also runs alone: `migrate`, `schedule`, `secrets`, `deploy`, `register`, `check`. Running them again
is safe.

## Configuration

| Secret                           | Default                                      |                                                              |
| -------------------------------- | -------------------------------------------- | ------------------------------------------------------------ |
| `STELLAR_NETWORK`                | none: required                               | `stellar:pubnet` (mainnet) or `stellar:testnet`              |
| `STELLAR_PAY_TO`                 | none: required                               | The payout G... address. It must hold a USDC trustline [P2]. |
| `STELLAR_FACILITATOR_AUTH`       | none: required on OpenZeppelin               | `Bearer <key>`                                               |
| `STELLAR_FACILITATOR_URL`        | OpenZeppelin on mainnet, x402.org on testnet |                                                              |
| `STELLAR_RPC_URL`                | `https://mainnet.sorobanrpc.com`             | For production traffic, an RPC provider's URL is safer.      |
| `STELLAR_AGENT_ID`               | none                                         | Saved by `register`; the manifest names it [I2].             |
| `STELLAR_PHONE_PRICE_USDC`       | `1`                                          |                                                              |
| `STELLAR_PHONE_CONCURRENCY`      | `2`                                          | Calls at once                                                |
| `STELLAR_PHONE_CALLS_PER_NUMBER` | `3`                                          | Calls to one number in 24 hours                              |
| `STELLAR_SWEEP_SECRET`           | generated by the deploy script               | Bearer secret of `/internal/sweep`                           |
| `STELLAR_PUBLIC_BASE_URL`        | `{SUPABASE_URL}/functions/v1/stellar`        |                                                              |

Twilio and OpenAI settings are the demo API's: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
`TWILIO_FROM_NUMBER`, `OPENAI_API_KEY`, `PHONE_CALL_REALTIME_MODEL`, `PHONE_CALL_VOICE`. The function refuses
to start when a money setting is missing or malformed.

## Files

| File                                           | Contents                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `functions/stellar/index.ts`                   | Wiring, and the manifest checked against the standard before the server starts             |
| `functions/stellar/app.ts`                     | Routes: manifest, create-job in the order of §5.4, check-status, get-result, Twilio, sweep |
| `functions/stellar/manifest.ts`                | The manifest, the `phone-call` schemas, and the name and description search reads          |
| `functions/stellar/phone.ts`                   | Pre-payment number checks, the dial, finishing a call, TwiML, callbacks, the voice bridge  |
| `functions/stellar/x402.ts`                    | The challenge, local payment checks, the facilitator client, settlement outcomes           |
| `functions/stellar/onchain.ts`                 | Deciding an uncertain payment from the chain                                               |
| `functions/stellar/store.ts`                   | The job store over the SQL functions                                                       |
| `functions/stellar/schema.ts`                  | The JSON Schema subset the service publishes, checked against Ajv in tests                 |
| `functions/stellar/config.ts`                  | Settings, failing closed                                                                   |
| `migrations/202611020001_stellar_services.sql` | `stellar_jobs`, `stellar_phone_calls`, `stellar_phone_optouts` and their functions         |
| `scripts/stellar-deploy.mjs`                   | Migrate, schedule, secrets, deploy, register, check                                        |

Tests (`deno task test`) run the real migration on PostgreSQL WASM with payments signed offline and fake
Twilio, facilitator and chain: no network, no keys, no money. The first real payment is yours to make.
