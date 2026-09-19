import type { SocialWorkflow } from './social.ts';
import type { SocialInput } from './social-input.ts';
import type { SocialStore } from './social-store.ts';
import type { PhoneCalls, PhoneInput } from './phone.ts';
import { uploadReference } from './references.ts';
import { Hono } from 'npm:hono@4.13.8';
import type { Config } from './config.ts';
import { PaymentGateway, type PaymentRequirements, receiptHeader } from './payments.ts';
import type { Job, Store } from './store.ts';
import {
  downloadAudio,
  downloadImage,
  downloadVideo,
  FalProvider,
  FalSubmissionError,
  parseWebhook,
} from './fal.ts';
import type { Artifacts } from './artifacts.ts';
import { bazaarFor, MODES, openApi, serviceDocument } from './services.ts';
import {
  compositionDuration,
  enabledServices,
  getService,
  providerInput,
  type Service,
  servicePayment,
} from './catalog.ts';
import { resolveSources } from './sources.ts';
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
  social?: Pick<SocialWorkflow, 'start' | 'advance' | 'progress' | 'parent' | 'sweep' | 'validateReferences'>;
  references?: Pick<SocialStore, 'reserveReference'>;
  phone?: Pick<PhoneCalls, 'validate' | 'start' | 'advance' | 'statusCallback' | 'stream'>;
  workflowSecret?: string;
  store: JobStore;
  payments: Pick<
    PaymentGateway,
    'requirements' | 'challenge' | 'parse' | 'fingerprint' | 'verify' | 'settle'
  >;
  fal: Pick<FalProvider, 'submit' | 'poll' | 'verifyWebhook'>;
  artifacts: Artifacts;
  download?: typeof downloadImage;
  downloadAudio?: typeof downloadAudio;
  downloadVideo?: typeof downloadVideo;
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

  const services = enabledServices(config);
  function findService(id: string) {
    const service = services.find((item) => item.id === id);
    if (!service) throw new HttpError(404, 'service-not-found');
    return service;
  }
  const target = (service: Service) => ({
    model: service.model,
    queuePath: service.queuePath,
    output: service.providerOutput,
  });
  async function document(service: Service) {
    const payment = servicePayment(config, service.id)!;
    return serviceDocument(config, await payments.requirements(payment.payTo, payment.priceAtomic), service);
  }

  async function response(job: Job, isStatus = false, signal?: AbortSignal) {
    let output = null;
    let deliveryPending = false;
    const outputKind = getService(job.service_id, job.service_version)?.outputKind;
    if (job.status === 'succeeded' && job.output && outputKind === 'call') {
      output = job.output;
    } else if (job.status === 'succeeded' && job.output) {
      const file = job.output as {
        path: string;
        content_type: string;
        width?: number;
        height?: number;
        file_size?: number;
        duration?: number;
      };
      try {
        const media = {
          url: await artifacts.signedUrl(file.path, signal),
          content_type: file.content_type,
          width: file.width,
          height: file.height,
          ...(file.file_size !== undefined ? { file_size: file.file_size } : {}),
          ...(file.duration !== undefined ? { duration: file.duration } : {}),
        };
        output = {
          ...(outputKind === 'audio'
            ? { audio: media }
            : outputKind === 'video'
            ? { video: media }
            : { images: [media] }),
          url_expires_in: 3600,
        };
      } catch (e) {
        if (!signal?.aborted) throw e;
        deliveryPending = true;
      }
    }
    const staleSettlement = job.status === 'settling' && Date.now() - Date.parse(job.updated_at) > 90000;
    const staleSubmission = job.status === 'submitting' && Date.now() - Date.parse(job.updated_at) > 30000;
    const progress = job.service_id === 'video.social' && d.social ? await d.social.progress(job) : undefined;
    const status = progress?.needs_reconciliation
      ? 'submission-uncertain'
      : job.status === 'payment_uncertain' || staleSettlement
      ? 'payment-uncertain'
      : staleSubmission
      ? 'submission-uncertain'
      : job.status;
    return json(
      {
        job_id: job.id,
        service_id: job.service_id,
        service_version: job.service_version,
        status: deliveryPending ? 'result-ready' : status,
        status_url: `${config.baseUrl}/v1/jobs/${job.id}`,
        poll_after_ms: inProgress(job) ? 3000 : undefined,
        ...(progress ? { progress } : {}),
        payment: job.payment_receipt,
        output,
        error: job.error,
        ...(status.endsWith('-uncertain')
          ? { message: 'Do not pay or submit again. This job requires payment/provider reconciliation.' }
          : status === 'paid'
          ? {
            message:
              'Payment is complete. Retry the original POST with the same input, Idempotency-Key and X-Recovery-Token to resume submission; do not pay again.',
          }
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
    if (job.service_id === 'video.social') {
      if (!d.social) throw new Error('Social workflow unavailable');
      return d.social.advance(job, signal);
    }
    if (job.service_id === 'phone.call') {
      if (!d.phone) throw new Error('Phone service unavailable');
      return d.phone.advance(job);
    }
    if (!job.provider_request_id || !['queued', 'running', 'saving'].includes(job.status)) return job;
    let result;
    const service = getService(job.service_id, job.service_version);
    if (!service) throw new Error('Unknown persisted service');
    try {
      result = await fal.poll(job.provider_request_id, signal, target(service));
    } catch {
      return (await store.get(job.id)) ?? job;
    }
    if (result.status === 'failed') {
      return store.failJob(job.id, 'generation-failed', 'The service could not complete this request.');
    }
    if (result.status === 'running') return store.markRunning(job.id);
    if (result.status !== 'succeeded') return job;
    const claim = await store.claimCompletion(job.id);
    if (!claim.claimed || !claim.leaseToken) return claim.job;
    try {
      const media = service.outputKind === 'audio'
        ? result.audio
        : service.outputKind === 'video'
        ? result.video
        : result.images?.[0];
      if (!media) {
        return await store.failJob(job.id, 'empty-result', 'The provider returned no output.');
      }
      const downloaded = await (service.outputKind === 'audio'
        ? (d.downloadAudio ?? downloadAudio)(media, signal)
        : service.outputKind === 'video'
        ? (d.downloadVideo ?? downloadVideo)(media, signal)
        : (d.download ?? downloadImage)(media, signal));
      if (
        service.outputKind !== 'images' &&
        (typeof downloaded.duration !== 'number' || !Number.isFinite(downloaded.duration) ||
          downloaded.duration <= 0)
      ) {
        return await store.failJob(
          job.id,
          'invalid-media-duration',
          'The generated media duration could not be verified.',
        );
      }
      if (
        service.id === 'video.slideshow' &&
        Math.abs(downloaded.duration! - compositionDuration(job.input)) > 2 / 24 + 0.002
      ) {
        return await store.failJob(
          job.id,
          'unexpected-video-duration',
          'The generated slideshow duration does not match the requested scene durations.',
        );
      }
      if (service.outputKind === 'video' && downloaded.duration! > 30.05) {
        return await store.failJob(
          job.id,
          'output-duration-limit',
          'The provider returned a video over the duration limit.',
        );
      }
      const extension = downloaded.contentType === 'image/png'
        ? 'png'
        : downloaded.contentType === 'image/webp'
        ? 'webp'
        : downloaded.contentType === 'audio/wav'
        ? 'wav'
        : downloaded.contentType === 'audio/mpeg'
        ? 'mp3'
        : downloaded.contentType === 'video/mp4'
        ? 'mp4'
        : 'jpg';
      const name = service.outputKind === 'audio'
        ? 'audio'
        : service.outputKind === 'video'
        ? 'video'
        : 'image';
      const path = `${job.id}/${name}.${extension}`;
      await artifacts.put(path, downloaded.bytes, downloaded.contentType, signal);
      return await store.complete(job.id, claim.leaseToken, {
        path,
        content_type: downloaded.contentType,
        width: media.width,
        height: media.height,
        file_size: downloaded.bytes.length,
        ...(downloaded.duration === undefined ? {} : { duration: downloaded.duration }),
      });
    } catch {
      // Persisted fal request is reusable: retry only retrieval/storage, never generation.
      return store.releaseCompletion(job.id, claim.leaseToken);
    }
  }

  async function submit(job: Job): Promise<Job> {
    if (job.service_id === 'video.social') {
      if (!d.social) throw new Error('Social workflow unavailable');
      return d.social.start(job);
    }
    if (job.service_id === 'phone.call') {
      if (!d.phone) throw new Error('Phone service unavailable');
      return d.phone.start(job);
    }
    const service = getService(job.service_id, job.service_version);
    if (!service) throw new Error('Unknown persisted service');
    // Source signing is retryable preparation, not a provider submission attempt.
    const input = await resolveSources(service, job.input, {
      supabaseUrl: config.supabaseUrl,
      store,
      artifacts,
    }, false);
    const claim = await store.claimSubmission(job.id);
    if (!claim.claimed) return claim.job;
    try {
      const result = await fal.submit(
        providerInput(service, input),
        `${config.baseUrl}/webhooks/fal`,
        target(service),
      );
      return await store.setSubmitted(job.id, result.requestId);
    } catch (e) {
      if (e instanceof FalSubmissionError && e.outcome === 'rejected') {
        return store.failJob(job.id, 'provider-rejected', 'The provider rejected the service request.');
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
    return json(await document(findService(c.req.param('service_id'))));
  });
  async function discovery(url: URL) {
    const params = url.searchParams;
    const query = params.get('query')?.toLocaleLowerCase().trim();
    const included = services.filter((service) => {
      for (
        const [key, value] of Object.entries({
          type: 'http',
          network: 'stellar:testnet',
          scheme: 'exact',
          payTo: servicePayment(config, service.id)!.payTo,
          extensions: 'bazaar',
        })
      ) {
        if (params.has(key) && params.get(key) !== value) return false;
      }
      if (
        query &&
        !query.split(/\s+/).some((term) =>
          JSON.stringify({
            id: service.id,
            name: service.name,
            description: service.description,
            tags: service.tags,
          }).toLocaleLowerCase().includes(term)
        )
      ) return false;
      return true;
    });
    const limit = params.has('limit') ? Number(params.get('limit')) : 20;
    const offset = params.has('offset') ? Number(params.get('offset')) : 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) {
      throw new HttpError(400, 'invalid-pagination');
    }
    const resources = await Promise.all(included.slice(offset, offset + limit).map(document));
    return json({
      x402Version: 2,
      resources,
      pagination: { limit, offset, total: included.length, cursor: null },
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
    const serviceId = c.req.param('service_id');
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
    let job = await store.get(id);
    let service: Service | undefined;
    if (job) {
      if (!(await tokenMatches(token, job.recovery_token_hash))) throw new HttpError(404, 'job-not-found');
      if (job.service_id !== serviceId) throw new HttpError(409, 'request-conflict');
      service = getService(job.service_id, job.service_version);
      if (!service) throw new Error('Unknown persisted service');
    } else {
      service = getService(serviceId);
      if (!service) throw new HttpError(404, 'service-not-found');
      if (!services.some((item) => item.id === serviceId)) throw new HttpError(404, 'service-not-found');
    }
    // Recovery must use the immutable version's input schema, even after a public upgrade.
    const input = await inputBody(c.req.raw, service);
    const inputHash = await hash(JSON.stringify({ service: service.id, input }));
    if (job) {
      if (job.input_hash !== inputHash) throw new HttpError(409, 'request-conflict');
    } else {
      if (!(await store.capacity()).available) throw new HttpError(429, 'demo-capacity-exhausted');
      if (service.id === 'video.social') {
        if (!d.social) throw new HttpError(503, 'social-unavailable');
        await d.social.validateReferences(input as SocialInput, true);
      }
      if (service.id === 'phone.call') {
        if (!d.phone) throw new HttpError(503, 'phone-unavailable');
        d.phone.validate(input as PhoneInput);
      }
      await resolveSources(service, input, { supabaseUrl: config.supabaseUrl, store, artifacts }, true);
      const payment = servicePayment(config, service.id)!;
      const requirements = await payments.requirements(payment.payTo, payment.priceAtomic);
      try {
        job = (await store.create({
          id,
          service_id: service.id,
          service_version: service.version,
          input,
          input_hash: inputHash,
          recovery_token_hash: await hash(token),
          requirements,
          resource_url: `${config.baseUrl}/v1/services/${service.id}`,
          expires_at: new Date(started + 10 * 60 * 1000).toISOString(),
        })).job;
        service = getService(job.service_id, job.service_version);
        if (!service) throw new Error('Unknown persisted service');
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
          service.description,
          { bazaar: bazaarFor(service) },
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

  app.post('/v1/references/:id', async (c) => {
    if (!d.references) throw new HttpError(503, 'reference-upload-unavailable');
    return json(await uploadReference(c.req.raw, c.req.param('id'), d.references, artifacts));
  });
  app.post('/internal/social/tick', async (c) => {
    const token = c.req.header('Authorization')?.replace(/^Bearer /i, '') ?? '';
    if (!d.workflowSecret || !(await tokenMatches(token, await hash(d.workflowSecret)))) {
      throw new HttpError(401, 'unauthorized');
    }
    if (!d.social) throw new HttpError(503, 'social-unavailable');
    await d.social.sweep();
    return json({ ok: true });
  });

  // Twilio Media Stream for a phone.call job; authenticated inside by the job's signed token.
  app.get('/phone/stream', (c) => {
    if (!d.phone) throw new HttpError(503, 'phone-unavailable');
    if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
      throw new HttpError(426, 'websocket-required');
    }
    return d.phone.stream(c.req.raw);
  });
  app.post('/webhooks/twilio/:id', async (c) => {
    if (!d.phone) throw new HttpError(503, 'phone-unavailable');
    const id = c.req.param('id');
    if (!validId(id)) throw new HttpError(404, 'job-not-found');
    const params = new URLSearchParams(new TextDecoder().decode(await readBytes(c.req.raw, 64 * 1024)));
    await d.phone.statusCallback(id, c.req.query('token') ?? '', params);
    return new Response('<Response/>', { headers: { 'content-type': 'text/xml' } });
  });

  app.post('/webhooks/fal', async (c) => {
    const body = await readBytes(c.req.raw, 1024 * 1024);
    if (!(await fal.verifyWebhook(body, c.req.raw.headers))) throw new HttpError(401, 'invalid-webhook');
    const event = parseWebhook(body);
    const job = await store.getByProviderId(event.requestId) ?? await d.social?.parent(event.requestId);
    if (!job) return json({ code: 'provider-job-not-linked' }, 503);
    await store.recordWebhook(await hash(body), event.requestId);
    const updated = await refresh(job, AbortSignal.timeout(45000));
    return json({ received: true }, ['succeeded', 'failed'].includes(updated.status) ? 200 : 503);
  });
  return app;
}
