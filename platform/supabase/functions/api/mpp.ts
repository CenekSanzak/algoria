import { Challenge, Credential, Receipt } from 'npm:mppx@0.13.1';
import { tempo } from 'npm:mppx@0.13.1/server';
import { type Client, createClient, http, type Transport } from 'npm:viem@2.57.3';
import { tempoModerato } from 'npm:viem@2.57.3/chains';
import type { Job } from './store.ts';

export const TEMPO_CHAIN = 42431;
export const TEMPO_TOKEN = '0x20c0000000000000000000000000000000000000';
export type MppConfig = { recipient: string; amount: string; secret: string };
type HashCredential = Credential.Credential<{ type: 'hash'; hash: `0x${string}` }>;

/** Push charges: chain settlement happens in the wallet, verification is read-only.
 * The existing database transaction-hash claim is the durable replay boundary.
 */
export class MppGateway {
  private method: ReturnType<typeof tempo.charge>[number];
  constructor(
    private config: MppConfig,
    client: Client<Transport, typeof tempoModerato> = createClient({
      chain: tempoModerato,
      transport: http(undefined, { retryCount: 0, timeout: 15_000 }),
    }),
  ) {
    if (
      !/^0x[0-9a-fA-F]{40}$/.test(config.recipient) ||
      /^0x0{40}$/.test(config.recipient) || !/^[1-9][0-9]{0,8}$/.test(config.amount) ||
      config.secret.length < 32
    ) throw new Error('Invalid Tempo MPP configuration');
    [this.method] = tempo.charge({
      currency: TEMPO_TOKEN,
      recipient: config.recipient as `0x${string}`,
      testnet: true,
      supportedModes: ['push'],
      getClient: () => client,
    });
  }

  quote(id: string, inputHash: string, resource: string, expires: string) {
    const challenge = Challenge.from({
      secretKey: this.config.secret,
      method: 'tempo',
      intent: 'charge',
      realm: new URL(resource).host,
      expires,
      meta: { job_id: id, input_hash: inputHash, resource },
      request: {
        amount: this.config.amount,
        currency: TEMPO_TOKEN,
        recipient: this.config.recipient.toLowerCase(),
        methodDetails: { chainId: TEMPO_CHAIN, supportedModes: ['push'] },
      },
    });
    return { protocol: 'mpp', chain: `eip155:${TEMPO_CHAIN}`, token: TEMPO_TOKEN, decimals: 6, challenge };
  }

  challenge(job: Job) {
    const challenge = job.requirements.challenge as Challenge.Challenge;
    return {
      body: { protocol: 'mpp', challenge, job_id: job.id, expires_at: job.expires_at },
      header: Challenge.serialize(challenge),
    };
  }

  parse(header: string, job: Job): HashCredential {
    if (!header || header.length > 32768) throw new Error('Invalid MPP credential');
    const credential = Credential.deserialize<{ type: 'hash'; hash: `0x${string}` }>(header);
    const saved = job.requirements.challenge as Challenge.Challenge;
    // Serialize through the SDK to compare canonical wire fields (opaque/meta).
    if (
      Challenge.serialize(credential.challenge) !== Challenge.serialize(saved) ||
      !Challenge.verify(credential.challenge, { secretKey: this.config.secret }) ||
      Date.parse(saved.expires!) <= Date.now() || credential.payload?.type !== 'hash' ||
      !/^0x[0-9a-fA-F]{64}$/.test(credential.payload.hash)
    ) throw new Error('MPP challenge mismatch');
    return credential;
  }

  async verify(credential: HashCredential) {
    // SDK verifies chain, successful receipt, token, recipient, amount and the
    // transferWithMemo attribution bound to this challenge/realm, including payer.
    const validation = await this.method.validate!({
      credential: credential as never,
      request: credential.challenge.request as never,
    });
    const payer = (validation.details as { sender: string }).sender;
    if (!/^0x[0-9a-fA-F]{40}$/.test(payer)) throw new Error('Invalid verified payer');
    return {
      payer,
      fingerprint: `mpp:eip155:${TEMPO_CHAIN}:${credential.payload.hash.toLowerCase()}`,
      receipt: {
        success: true,
        protocol: 'mpp',
        network: `eip155:${TEMPO_CHAIN}`,
        token: TEMPO_TOKEN,
        decimals: 6,
        amount: credential.challenge.request.amount,
        payer,
        transaction: credential.payload.hash,
        mpp: Receipt.from({
          method: 'tempo',
          status: 'success',
          reference: credential.payload.hash,
          timestamp: new Date().toISOString(),
        }),
      },
    };
  }
}

export function mppReceiptHeader(receipt: Record<string, unknown>) {
  return Receipt.serialize(receipt.mpp as Receipt.Receipt);
}
