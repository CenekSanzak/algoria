import { Hono } from 'npm:hono@4.13.8';
import type { Config } from './config.ts';
import { PaymentGateway, type PaymentRequirements, receiptHeader } from './payments.ts';
import type { Job, Store } from './store.ts';
import { downloadImage, FalProvider, FalSubmissionError, parseWebhook } from './fal.ts';
import type { Artifacts } from './artifacts.ts';
import { BAZAAR, IMAGE_SERVICE, MODES, openApi, serviceDocument } from './services.ts';
import { hash, HttpError, inputBody, readBytes, tokenMatches, validId, validToken } from './security.ts';

type JobStore = Pick<
  Store,
  | 'get'
  | 'getByProviderId'
  | 'create'
  | 'capacity'
  | 'claimPayment'
  | 'finishPayment'
  | 'claimSubmission'
  | 'setSubmitted'
  | 'failJob'
  | 'claimCompletion'
  | 'complete'
  | 'releaseCompletion'
  | 'markRunning'
  | 'recordWebhook'
>;
export interface Dependencies {
  config: Config;
  store: JobStore;
  payments: Pick<
    PaymentGateway,
    'requirements' | 'challenge' | 'parse' | 'fingerprint' | 'verify' | 'settle'
  >;
  fal: Pick<FalProvider, 'submit' | 'poll' | 'verifyWebhook'>;
  artifacts: Artifacts;
  download?: typeof downloadImage;
  sleep?: (ms: number) => Promise<void>;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}
const inProgress = (job: Job) => !['awaiting_payment', 'succeeded', 'failed'].includes(job.status);

export function createApp(d: Dependencies) {
  const { config, store, payments, fal, artifacts } = d;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const app = new Hono({
    getPath(request) {
      const path = new URL(request.url).pathname;
      return path.replace(/^\/functions\/v1\/api(?=\/|$)/, '').replace(/^\/api(?=\/|$)/, '') || '/';
    },
  });

  async function document() {
    return serviceDocument(config, await payments.requirements(config.imagePayTo, config.priceAtomic));
  }

  async function response(job: Job, isStatus = false, signal?: AbortSignal) {
    let output = null;
    let deliveryPending = false;
    if (job.status === 'succeeded' && job.output) {
      const file = job.output as { path: string; content_type: string; width?: number; height?: number };
      try {
        output = {
          images: [{
            url: await artifacts.signedUrl(file.path, signal),
            content_type: file.content_type,
            width: file.width,
            height: file.height,
          }],
          url_expires_in: 3600,
        };
      } catch (e) {
        if (!signal?.aborted) throw e;
        deliveryPending = true;
      }
    }
    const staleSettlement = job.status === 'settling' && Date.now() - Date.parse(job.updated_at) > 90000;
    const staleSubmission = job.status === 'submitting' && Date.now() - Date.parse(job.updated_at) > 30000;
    const status = job.status === 'payment_uncertain' || staleSettlement
      ? 'payment-uncertain'
      : staleSubmission
      ? 'submission-uncertain'
      : job.status;
    return json(
      {
        job_id: job.id,
        service_id: job.service_id,
        status: deliveryPending ? 'result-ready' : status,
        status_url: `${config.baseUrl}/v1/jobs/${job.id}`,
        poll_after_ms: inProgress(job) ? 3000 : undefined,
        payment: job.payment_receipt,
        output,
        error: job.error,
        ...(status.endsWith('-uncertain')
          ? { message: 'Do not pay or submit again. This job requires payment/provider reconciliation.' }
          : {}),
      },
      isStatus
        ? 200
        : job.status === 'succeeded' && !deliveryPending
        ? 200
        : job.status === 'failed'
        ? 502
        : 202,
      {
        ...(job.payment_receipt?.success ? { 'PAYMENT-RESPONSE': receiptHeader(job.payment_receipt) } : {}),
        ...(inProgress(job) ? { 'Retry-After': '3' } : {}),
      },
    );
  }

  async function refresh(job: Job, signal?: AbortSignal): Promise<Job> {
    if (!job.provider_request_id || !['queued', 'running', 'saving'].includes(job.status)) return job;
    let result;
    try {
      result = await fal.poll(job.provider_request_id, signal);
    } catch {
      return (await store.get(job.id)) ?? job;
    }
    if (result.status === 'failed') {
      return store.failJob(job.id, 'generation-failed', 'The image service could not complete this request.');
    }
    if (result.status === 'running') return store.markRunning(job.id);
    if (result.status !== 'succeeded') return job;
    const claim = await store.claimCompletion(job.id);
    if (!claim.claimed || !claim.leaseToken) return claim.job;
    try {
      if (!result.images?.length) {
        return await store.failJob(job.id, 'empty-result', 'The provider returned no image.');
      }
      const image = result.images[0];
      const downloaded = await (d.download ?? downloadImage)(image, signal);
      const extension = downloaded.contentType === 'image/png'
        ? 'png'
        : downloaded.contentType === 'image/webp'
        ? 'webp'
        : 'jpg';
      const path = `${job.id}/image.${extension}`;
      await artifacts.put(path, downloaded.bytes, downloaded.contentType, signal);
      return await store.complete(job.id, claim.leaseToken, {
        path,
        content_type: downloaded.contentType,
        width: image.width,
        height: image.height,
      });
    } catch {
      // Persisted fal request is reusable: retry only retrieval/storage, never generation.
      return store.releaseCompletion(job.id, claim.leaseToken);
    }
  }

  async function submit(job: Job): Promise<Job> {
    const claim = await store.claimSubmission(job.id);
    if (!claim.claimed) return claim.job;
    try {
      const result = await fal.submit(job.input, `${config.baseUrl}/webhooks/fal`);
      return await store.setSubmitted(job.id, result.requestId);
    } catch (e) {
      if (e instanceof FalSubmissionError && e.outcome === 'rejected') {
        return store.failJob(job.id, 'provider-rejected', 'The provider rejected the image request.');
      }
      // The provider may have accepted it. Never auto-resubmit a missing request ID.
      return (await store.get(job.id)) ?? claim.job;
    }
  }

  app.use('*', async (c, next) => {
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Cache-Control', 'no-store');
    await next();
  });
  app.onError((e) => {
    if (e instanceof HttpError) return json({ code: e.code, message: e.message }, e.status);
    // Log only the class; SDK errors can contain authorization or user prompts.
    console.error('API request failed', e.name);
    return json({
      code: 'temporarily-unavailable',
      message: 'Retry the same request identity or check its status.',
    }, 503);
  });
  app.notFound(() => json({ code: 'not-found' }, 404));
  app.get(
    '/health',
    () => json({ ok: true, service: 'algoria', network: 'stellar:testnet', version: '1.0.0' }),
  );
  app.get('/openapi.json', () => json(openApi(config)));
  app.get('/v1/services/:service_id', async (c) => {
    if (c.req.param('service_id') !== IMAGE_SERVICE.id) throw new HttpError(404, 'service-not-found');
    return json(await document());
  });
  async function discovery(url: URL) {
    const doc = await document();
    const params = url.searchParams;
    const query = params.get('query')?.toLocaleLowerCase().trim();
    let included = true;
    for (
      const [key, value] of Object.entries({
        type: 'http',
        network: 'stellar:testnet',
        scheme: 'exact',
        payTo: config.imagePayTo,
        extensions: 'bazaar',
      })
    ) {
      if (params.has(key) && params.get(key) !== value) included = false;
    }
    if (
      query &&
      !query.split(/\s+/).some((term) => JSON.stringify(IMAGE_SERVICE).toLocaleLowerCase().includes(term))
    ) included = false;
    const limit = params.has('limit') ? Number(params.get('limit')) : 20;
    const offset = params.has('offset') ? Number(params.get('offset')) : 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) {
      throw new HttpError(400, 'invalid-pagination');
    }
    const resources = included && offset === 0 ? [doc] : [];
    return json({
      x402Version: 2,
      resources,
      pagination: { limit, offset, total: included ? 1 : 0, cursor: null },
    });
  }
  app.get('/discovery/resources', (c) => discovery(new URL(c.req.url)));
  app.get('/discovery/search', (c) => {
    const url = new URL(c.req.url);
    if (!url.searchParams.get('query')?.trim()) throw new HttpError(400, 'query-required');
    return discovery(url);
  });

  app.post('/v1/services/:service_id', async (c) => {
    const started = Date.now();
    if (c.req.param('service_id') !== IMAGE_SERVICE.id) throw new HttpError(404, 'service-not-found');
    const mode = c.req.query('mode') ?? 'sync';
    const wait = c.req.query('wait_ms') === undefined
      ? MODES.default_wait_ms
      : Number(c.req.query('wait_ms'));
    if (
      !['sync', 'async'].includes(mode) || !Number.isInteger(wait) || wait < 0 || wait > MODES.max_wait_ms
    ) throw new HttpError(400, 'invalid-execution-mode');
    const id = c.req.header('Idempotency-Key') ?? '';
    const token = c.req.header('X-Recovery-Token') ?? '';
    if (!validId(id) || !validToken(token)) {
      throw new HttpError(
        400,
        'request-identity-required',
        'Send a UUID v4 Idempotency-Key and random base64url X-Recovery-Token.',
      );
    }
    const input = await inputBody(c.req.raw);
    const inputHash = await hash(JSON.stringify({ service: IMAGE_SERVICE.id, input }));
    let job = await store.get(id);
    if (job) {
      if (!(await tokenMatches(token, job.recovery_token_hash))) throw new HttpError(404, 'job-not-found');
      if (job.input_hash !== inputHash || job.service_id !== IMAGE_SERVICE.id) {
        throw new HttpError(409, 'request-conflict');
      }
    } else {
      if (!(await store.capacity()).available) throw new HttpError(429, 'demo-capacity-exhausted');
      const requirements = await payments.requirements(config.imagePayTo, config.priceAtomic);
      try {
        job = (await store.create({
          id,
          service_id: IMAGE_SERVICE.id,
          service_version: IMAGE_SERVICE.version,
          input,
          input_hash: inputHash,
          recovery_token_hash: await hash(token),
          requirements,
          resource_url: `${config.baseUrl}/v1/services/${IMAGE_SERVICE.id}`,
          expires_at: new Date(started + 10 * 60 * 1000).toISOString(),
        })).job;
      } catch (e) {
        if (e instanceof Error && e.message.includes('job-snapshot-conflict')) {
          throw new HttpError(409, 'request-conflict');
        }
        if (e instanceof Error && e.message.includes('quote-capacity-exhausted')) {
          throw new HttpError(429, 'quote-capacity-exhausted');
        }
        throw e;
      }
    }
    if (job.status === 'awaiting_payment') {
      if (Date.parse(job.expires_at) <= Date.now()) {
        throw new HttpError(409, 'quote-expired', 'This unpaid request expired. Use a new request identity.');
      }
      const signature = c.req.header('PAYMENT-SIGNATURE');
      if (!signature) {
        if (!(await store.capacity()).available) throw new HttpError(429, 'demo-capacity-exhausted');
        const challenge = payments.challenge(
          job.requirements as PaymentRequirements,
          job.resource_url,
          IMAGE_SERVICE.description,
          { bazaar: BAZAAR },
        );
        return json({ ...challenge.body, job_id: id, expires_at: job.expires_at }, 402, {
          'PAYMENT-REQUIRED': challenge.header,
        });
      }
      if (signature.length > 32768) throw new HttpError(400, 'payment-header-too-large');
      let payload;
      try {
        payload = payments.parse(signature);
      } catch {
        throw new HttpError(400, 'invalid-payment-payload');
      }
      const verified = await payments.verify(payload, job.requirements as PaymentRequirements);
      if (!verified.valid || !verified.payer) {
        const transient = verified.reason?.startsWith('facilitator_');
        throw new HttpError(transient ? 503 : 402, verified.reason ?? 'invalid-payment');
      }
      const fingerprint = await payments.fingerprint(payload);
      const claim = await store.claimPayment(id, fingerprint, verified.payer, payload);
      job = claim.job;
      if (!claim.claimed && claim.reason === 'capacity-exhausted') {
        throw new HttpError(429, 'demo-capacity-exhausted');
      }
      if (!claim.claimed && claim.reason === 'payment-replayed') {
        throw new HttpError(409, 'payment-already-used');
      }
      if (!claim.claimed && claim.reason === 'expired') throw new HttpError(409, 'quote-expired');
      if (claim.claimed) {
        const settlement = await payments.settle(payload, job.requirements as PaymentRequirements);
        job = await store.finishPayment(id, settlement.outcome, settlement.receipt);
        if (settlement.outcome === 'failed') {
          return json({ code: 'payment-failed', job_id: id, payment: settlement.receipt }, 402);
        }
      }
    }
    if (job.status === 'paid') job = await submit(job);
    const deadline = started + wait;
    if (mode === 'sync' && Date.now() < deadline) {
      const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
      while (['queued', 'running', 'saving'].includes(job.status) && !signal.aborted) {
        job = await refresh(job, signal);
        if (!['queued', 'running', 'saving'].includes(job.status) || signal.aborted) break;
        await sleep(Math.min(2000, Math.max(0, deadline - Date.now())));
      }
    }
    return response(
      job,
      false,
      mode === 'sync' ? AbortSignal.timeout(Math.max(1, deadline - Date.now())) : undefined,
    );
  });

  app.get('/v1/jobs/:id', async (c) => {
    const id = c.req.param('id');
    const token = c.req.header('Authorization')?.replace(/^Bearer /i, '') ?? '';
    if (!validId(id)) throw new HttpError(404, 'job-not-found');
    let job = await store.get(id);
    if (!job || !(await tokenMatches(token, job.recovery_token_hash))) {
      throw new HttpError(404, 'job-not-found');
    }
    job = await refresh(job, AbortSignal.timeout(30000));
    return response(job, true);
  });

  app.post('/webhooks/fal', async (c) => {
    const body = await readBytes(c.req.raw, 1024 * 1024);
    if (!(await fal.verifyWebhook(body, c.req.raw.headers))) throw new HttpError(401, 'invalid-webhook');
    const event = parseWebhook(body);
    const job = await store.getByProviderId(event.requestId);
    if (!job) return json({ code: 'provider-job-not-linked' }, 503);
    await store.recordWebhook(await hash(body), event.requestId);
    const updated = await refresh(job, AbortSignal.timeout(45000));
    return json({ received: true }, ['succeeded', 'failed'].includes(updated.status) ? 200 : 503);
  });
  return app;
}
