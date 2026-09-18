import { deepEqual, equal, notEqual, rejects, throws } from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  Account,
  Address,
  Asset,
  Keypair,
  nativeToScVal,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
} from 'npm:@stellar/stellar-sdk@16.2.0';
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from 'npm:@x402/core@2.22.0/http';
import { type FacilitatorClient, FacilitatorTimeoutError } from 'npm:@x402/core@2.22.0/server';
import {
  type PaymentPayload,
  type PaymentRequirements,
  SettleError,
  type SettleResponse,
} from 'npm:@x402/core@2.22.0/types';
import { ASSET, NETWORK, PaymentGateway, receiptHeader } from './payments.ts';

const PAYER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));
const RECIPIENT = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2)).publicKey();
const OTHER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3)).publicKey();
const HASH = 'a'.repeat(64);
const REQUIREMENTS: PaymentRequirements = {
  scheme: 'exact',
  network: NETWORK,
  asset: ASSET,
  amount: '100000',
  payTo: RECIPIENT,
  maxTimeoutSeconds: 120,
  extra: { areFeesSponsored: true },
};

function fixture(
  options: {
    nonce?: string;
    signature?: string;
    recipient?: string;
    amount?: string;
    source?: string;
    sequence?: string;
    expiration?: number;
    signEnvelope?: boolean;
    authCount?: number;
  } = {},
): PaymentPayload {
  const args = [
    nativeToScVal(PAYER.publicKey(), { type: 'address' }),
    nativeToScVal(options.recipient ?? RECIPIENT, { type: 'address' }),
    nativeToScVal(options.amount ?? '100000', { type: 'i128' }),
  ];
  const invocation = new xdr.InvokeContractArgs({
    contractAddress: new Address(ASSET).toScAddress(),
    functionName: 'transfer',
    args,
  });
  const auth = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(PAYER.publicKey()).toScAddress(),
        nonce: xdr.Int64.fromString(options.nonce ?? '928374'),
        signatureExpirationLedger: options.expiration ?? 5000,
        // The mock facilitator is the signature verifier; no real signing key or chain is used.
        signature: nativeToScVal(options.signature ?? 'fixture-signature'),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(invocation),
      subInvocations: [],
    }),
  });
  const transaction = new TransactionBuilder(
    new Account(options.source ?? PAYER.publicKey(), options.sequence ?? '0'),
    { fee: '100', networkPassphrase: Networks.TESTNET },
  )
    .addOperation(
      Operation.invokeContractFunction({
        contract: ASSET,
        function: 'transfer',
        args,
        auth: Array.from({ length: options.authCount ?? 1 }, () => auth),
      }),
    )
    .setTimeout(120).build();
  if (options.signEnvelope) transaction.sign(PAYER);
  return {
    x402Version: 2,
    accepted: structuredClone(REQUIREMENTS),
    payload: { transaction: transaction.toXDR() },
  };
}

function setup(overrides: Partial<FacilitatorClient> = {}) {
  const calls: { operation: string; payload: PaymentPayload; requirements: PaymentRequirements }[] = [];
  const facilitator: FacilitatorClient = {
    getSupported: () =>
      Promise.resolve({
        kinds: [{ x402Version: 2, scheme: 'exact', network: NETWORK, extra: { areFeesSponsored: true } }],
        extensions: [],
        signers: {},
      }),
    verify: (payload, requirements) => {
      calls.push({ operation: 'verify', payload, requirements });
      return Promise.resolve({ isValid: true, payer: PAYER.publicKey() });
    },
    settle: (payload, requirements) => {
      calls.push({ operation: 'settle', payload, requirements });
      return Promise.resolve({
        success: true,
        transaction: HASH,
        network: NETWORK,
        payer: PAYER.publicKey(),
      });
    },
    ...overrides,
  };
  return { gateway: new PaymentGateway(undefined, { facilitator }), calls };
}

Deno.test("testnet USDC is the mock anchor asset's Stellar asset contract", () => {
  equal(
    new Asset('USDC', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5').contractId(
      Networks.TESTNET,
    ),
    ASSET,
  );
});

Deno.test('requirements check facilitator support and roundtrip standard 402 metadata', async () => {
  const { gateway } = setup();
  const requirements = await gateway.requirements(RECIPIENT, '100000');
  const extensions = { bazaar: { info: { input: { type: 'http' } } } };
  const challenge = gateway.challenge(
    requirements,
    'https://example.test/v1/services/image.generate',
    'Generate an image',
    extensions,
  );
  deepEqual(decodePaymentRequiredHeader(challenge.header), challenge.body);
  deepEqual(challenge.body.extensions, extensions);
  await rejects(() =>
    setup({ getSupported: () => Promise.resolve({ kinds: [], extensions: [], signers: {} }) }).gateway
      .requirements(RECIPIENT, '100000')
  );
});

Deno.test('payment parser rejects wrong network, asset, protocol and oversized headers', () => {
  const { gateway } = setup();
  for (
    const changed of [
      { ...fixture(), x402Version: 1 },
      { ...fixture(), accepted: { ...REQUIREMENTS, network: 'stellar:pubnet' as const } },
      { ...fixture(), accepted: { ...REQUIREMENTS, asset: OTHER } },
      { ...fixture(), accepted: { ...REQUIREMENTS, amount: '-1' } },
    ]
  ) throws(() => gateway.parse(encodePaymentSignatureHeader(changed)));
  throws(() => gateway.parse('A'.repeat(32_769)));
  throws(() => gateway.parse('not-base64'));
  deepEqual(gateway.parse(encodePaymentSignatureHeader(fixture())).accepted, REQUIREMENTS);
});

Deno.test('immutable requirements and actual transfer prevent accepted-field tampering', async () => {
  const { gateway, calls } = setup();
  for (const field of ['payTo', 'amount', 'maxTimeoutSeconds', 'extra'] as const) {
    const payload = fixture();
    Object.assign(payload.accepted, {
      [field]: field === 'payTo'
        ? OTHER
        : field === 'amount'
        ? '1'
        : field === 'extra'
        ? { areFeesSponsored: false }
        : 60,
    });
    equal((await gateway.verify(payload, REQUIREMENTS)).valid, false);
  }
  equal((await gateway.verify(fixture({ recipient: OTHER }), REQUIREMENTS)).valid, false);
  equal((await gateway.verify(fixture({ amount: '1' }), REQUIREMENTS)).valid, false);
  equal((await gateway.verify(fixture({ authCount: 2 }), REQUIREMENTS)).valid, false);
  equal(calls.length, 0);
});

Deno.test('fingerprint ignores JSON and envelope/signature changes but changes with auth nonce', async () => {
  const { gateway } = setup();
  const original = await gateway.fingerprint(fixture());
  const altered = fixture({
    signature: 'other-signature',
    source: OTHER,
    sequence: '5',
    expiration: 5010,
    signEnvelope: true,
  });
  altered.payload.arbitrary = 'extra';
  altered.extensions = { bazaar: { injected: true } };
  equal(await gateway.fingerprint(altered), original);
  notEqual(await gateway.fingerprint(fixture({ nonce: '928375' })), original);
  await rejects(() => gateway.fingerprint(fixture({ authCount: 2 })));
});

Deno.test('facilitator receives only payment fields without service discovery metadata', async () => {
  const { gateway, calls } = setup();
  const payload = fixture();
  payload.resource = { url: 'https://private-catalogue.example/service' };
  payload.extensions = { bazaar: { info: {} } };
  payload.payload.extra = 'do-not-forward';
  deepEqual(await gateway.verify(payload, REQUIREMENTS), { valid: true, payer: PAYER.publicKey() });
  const settlement = await gateway.settle(payload, REQUIREMENTS);
  equal(settlement.outcome, 'success');
  equal(decodePaymentResponseHeader(receiptHeader(settlement.receipt)).transaction, HASH);
  equal(calls.length, 2);
  for (const call of calls) {
    deepEqual(Object.keys(call.payload).sort(), ['accepted', 'payload', 'x402Version']);
    deepEqual(Object.keys(call.payload.payload), ['transaction']);
    deepEqual(call.requirements, REQUIREMENTS);
  }
});

Deno.test('settlement timeout and ambiguous upstream failures are uncertain, with no retry', async () => {
  for (
    const failure of [
      new FacilitatorTimeoutError('settle', 20_000),
      new Error('connection closed after submission'),
      new SettleError(503, {
        success: false,
        network: NETWORK,
        transaction: '',
        errorReason: 'verification_failed',
      }),
    ]
  ) {
    let attempts = 0;
    const { gateway } = setup({
      settle: () => {
        attempts++;
        return Promise.reject(failure);
      },
    });
    equal((await gateway.settle(fixture(), REQUIREMENTS)).outcome, 'uncertain');
    equal(attempts, 1);
  }
  const uncertainResults: SettleResponse[] = [
    {
      success: false,
      network: NETWORK,
      transaction: HASH,
      errorReason: 'settle_exact_stellar_transaction_failed',
    },
    { success: false, network: NETWORK, transaction: '', errorReason: 'unexpected_settle_error' },
    { success: true, network: 'stellar:pubnet', transaction: HASH },
    { success: true, network: NETWORK, transaction: '' },
    { success: true, network: NETWORK, transaction: HASH, amount: '1' },
  ];
  for (const result of uncertainResults) {
    equal(
      (await setup({ settle: () => Promise.resolve(result) }).gateway.settle(fixture(), REQUIREMENTS))
        .outcome,
      'uncertain',
    );
  }
});

Deno.test('definite verification failures are failed, transient verify errors stay distinguishable', async () => {
  const { gateway } = setup({
    settle: () =>
      Promise.resolve({
        success: false,
        network: NETWORK,
        transaction: '',
        errorReason: 'invalid_exact_stellar_payload_wrong_amount',
      }),
  });
  equal((await gateway.settle(fixture(), REQUIREMENTS)).outcome, 'failed');
  equal(
    (await setup({ verify: () => Promise.reject(new FacilitatorTimeoutError('verify', 20_000)) }).gateway
      .verify(fixture(), REQUIREMENTS)).reason,
    'facilitator_timeout',
  );
});
