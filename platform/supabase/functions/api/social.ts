import type { Artifacts } from './artifacts.ts';
import { COMPOSE_SERVICE, getService, providerInput, SLIDESHOW_SERVICE, SPEECH_SERVICE } from './catalog.ts';
import {
  downloadAudio,
  downloadImage,
  downloadVideo,
  type FalProvider,
  FalSubmissionError,
  type FalTarget,
} from './fal.ts';
import type { SocialInput } from './social-input.ts';
import type { SocialStore, StoredMedia } from './social-store.ts';
import type { Job, Store } from './store.ts';
import { HttpError } from './security.ts';

type Dependencies = {
  store: Pick<Store, 'get' | 'claimCompletion' | 'releaseCompletion' | 'complete' | 'failJob'>;
  repository: Pick<SocialStore, 'start' | 'steps' | 'write' | 'parent' | 'active' | 'referencePath'>;
  fal: Pick<FalProvider, 'submit' | 'poll'>;
  artifacts: Artifacts;
  baseUrl: string;
  supabaseUrl: string;
  downloadImage?: typeof downloadImage;
  downloadAudio?: typeof downloadAudio;
  downloadVideo?: typeof downloadVideo;
};
const targetFor = (name: string, references: boolean): FalTarget => {
  if (name.startsWith('image-')) {
    return references
      ? { model: 'fal-ai/nano-banana-2/edit', queuePath: 'fal-ai/nano-banana-2', output: 'images' }
      : { model: 'google/nano-banana-2-lite', queuePath: 'google/nano-banana-2-lite', output: 'images' };
  }
  const service = name === 'speech'
    ? SPEECH_SERVICE
    : name === 'slideshow'
    ? SLIDESHOW_SERVICE
    : name === 'compose'
    ? COMPOSE_SERVICE
    : getService('video.caption')!;
  return { model: service.model, queuePath: service.queuePath, output: service.providerOutput };
};

/** The edit model can omit width/height metadata. Read the requested PNG itself. */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (
    bytes.length < 33 || ![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v) ||
    new TextDecoder().decode(bytes.subarray(12, 16)) !== 'IHDR'
  ) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16), height = view.getUint32(20);
  if (view.getUint32(8) !== 13 || width < 1 || height < 1 || width > 2048 || height > 2048) return undefined;
  return { width, height };
}

/** Durations use whole video frames and always cover all of the verified audio. */
export function sceneDurations(audioSeconds: number, count: number): number[] {
  if (!Number.isFinite(audioSeconds) || audioSeconds <= 0 || audioSeconds > 29.8 || count < 1 || count > 5) {
    throw new Error('Narration must fit within 29.8 seconds.');
  }
  const frames = Math.max(count * 12, Math.ceil(audioSeconds * 24));
  return Array.from(
    { length: count },
    (_, i) =>
      (Math.floor(Math.floor((i + 1) * frames / count) * 1000 / 24) -
        Math.floor(Math.floor(i * frames / count) * 1000 / 24)) / 1000,
  );
}

export class SocialWorkflow {
  constructor(private d: Dependencies) {}
  async validateReferences(input: SocialInput, verifyAccess: boolean): Promise<string[]> {
    return await Promise.all(input.references.map(async (ref) => {
      const url = new URL(ref.url);
      const prefix = '/storage/v1/object/sign/outputs/';
      const path = decodeURIComponent(url.pathname.slice(prefix.length));
      if (
        url.origin !== new URL(this.d.supabaseUrl).origin || !url.pathname.startsWith(prefix) ||
        !/^references\/[0-9a-f-]{36}\/[0-9a-f]{64}\.(png|jpg|webp)$/.test(path) ||
        !url.searchParams.get('token') || !(await this.d.repository.referencePath(path))
      ) throw new HttpError(400, 'invalid-reference', 'Upload reference photos with the reference endpoint.');
      if (verifyAccess) {
        const response = await fetch(url, {
          method: 'HEAD',
          redirect: 'error',
          signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) {
          throw new HttpError(
            400,
            'reference-unavailable',
            'Refresh the reference upload URL before quoting.',
          );
        }
      }
      return await this.d.artifacts.signedUrl(path);
    }));
  }
  async start(job: Job): Promise<Job> {
    return await this.advance(await this.d.repository.start(job.id));
  }
  async parent(providerId: string) {
    const id = await this.d.repository.parent(providerId);
    return id ? await this.d.store.get(id) : null;
  }
  async progress(job: Job) {
    const steps = await this.d.repository.steps(job.id);
    return {
      completed: steps.filter((s) => s.state === 'succeeded').length,
      total: (job.input.scenes as string[]).length + 3 + (job.input.captions ? 1 : 0),
      steps: steps.map((s) => ({ name: s.name, status: s.state })),
      needs_reconciliation: steps.some((s) =>
        s.state === 'uncertain' || (s.state === 'submitting' && job.status !== 'saving')
      ),
    };
  }
  async sweep() {
    const jobs = await this.d.repository.active();
    // Each tick is bounded; no request sleeps waiting for generation.
    return await Promise.allSettled(jobs.map((j) => j.status === 'paid' ? this.start(j) : this.advance(j)));
  }
  async advance(job: Job, callerSignal?: AbortSignal): Promise<Job> {
    if (!['queued', 'running', 'saving'].includes(job.status)) return job;
    const { store, repository, artifacts, fal } = this.d;
    const claim = await store.claimCompletion(job.id);
    if (!claim.claimed || !claim.leaseToken) return claim.job;
    const lease = claim.leaseToken;
    const input = job.input as SocialInput;
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, AbortSignal.timeout(85000)])
      : AbortSignal.timeout(85000);
    try {
      let steps = await repository.steps(job.id);
      // A prior isolate may have died after dispatch and before saving its ID.
      // No resubmission: keep the paid job reserved for reconciliation.
      for (const step of steps.filter((s) => s.state === 'submitting')) {
        await repository.write(job.id, lease, step.name, 'uncertain');
      }
      steps = await repository.steps(job.id);
      if (steps.some((s) => s.state === 'uncertain')) return job;
      // Bound media download memory to two files at a time.
      const queued = steps.filter((s) => s.state === 'queued');
      for (let i = 0; i < queued.length; i += 2) {
        const polled = await Promise.allSettled(
          queued.slice(i, i + 2).map(async (step) => {
            const result = await fal.poll(
              step.provider_id!,
              signal,
              targetFor(step.name, input.references.length > 0),
            );
            if (result.status === 'failed') {
              await repository.write(job.id, lease, step.name, 'failed');
              return;
            }
            if (result.status !== 'succeeded') return;
            const kind = step.name.startsWith('image-')
              ? 'image'
              : step.name === 'speech'
              ? 'audio'
              : 'video';
            const media = kind === 'image'
              ? result.images?.[0]
              : kind === 'audio'
              ? result.audio
              : result.video;
            if (!media) throw new Error('Missing provider media');
            const file = await (kind === 'image'
              ? (this.d.downloadImage ?? downloadImage)(media, signal)
              : kind === 'audio'
              ? (this.d.downloadAudio ?? downloadAudio)(media, signal)
              : (this.d.downloadVideo ?? downloadVideo)(media, signal));
            if (kind !== 'image' && (!file.duration || file.duration > (kind === 'audio' ? 29.8 : 30.05))) {
              await repository.write(job.id, lease, step.name, 'failed');
              return;
            }
            const dimensions = kind === 'image' && file.contentType === 'image/png'
              ? pngDimensions(file.bytes)
              : undefined;
            if (
              kind === 'image' &&
              (!dimensions || Math.abs(dimensions.width / dimensions.height - 9 / 16) > 0.02)
            ) {
              await repository.write(job.id, lease, step.name, 'failed');
              return;
            }
            if (step.name === 'slideshow' || step.name === 'compose' || step.name === 'caption') {
              const audio = steps.find((s) =>
                s.name === 'speech'
              )?.output;
              const planned = audio?.duration
                ? sceneDurations(audio.duration, input.scenes.length).reduce((a, b) => a + b, 0)
                : NaN;
              if (
                !Number.isFinite(planned) || file.duration! + 0.05 < audio!.duration! ||
                Math.abs(file.duration! - planned) > 0.2
              ) {
                await repository.write(job.id, lease, step.name, 'failed');
                return;
              }
            }
            const extension = file.contentType === 'image/png'
              ? 'png'
              : file.contentType === 'image/webp'
              ? 'webp'
              : kind === 'image'
              ? 'jpg'
              : kind === 'audio'
              ? 'wav'
              : 'mp4';
            const path = `${job.id}/${step.name}.${extension}`;
            await artifacts.put(path, file.bytes, file.contentType, signal);
            await repository.write(job.id, lease, step.name, 'succeeded', undefined, {
              path,
              content_type: file.contentType,
              file_size: file.bytes.length,
              ...(file.duration ? { duration: file.duration } : {}),
              ...(dimensions ?? {}),
            });
          }),
        );
        if (polled.some((r) => r.status === 'rejected')) throw new Error('Provider retrieval pending');
      }
      steps = await repository.steps(job.id);
      if (steps.some((s) => s.state === 'failed')) {
        return await store.failJob(
          job.id,
          'social-step-failed',
          'A generation failed or did not meet the approved media limits. Completed steps are retained; do not pay again.',
        );
      }
      const final = steps.find((s) => s.name === (input.captions ? 'caption' : 'compose'));
      if (final?.state === 'succeeded') {
        const image = steps.find((s) => s.name === 'image-0')!.output!;
        return await store.complete(job.id, lease, {
          ...final.output!,
          width: image.width,
          height: image.height,
        });
      }
      const completed = (name: string) =>
        steps.find((s) => s.name === name && s.state === 'succeeded')?.output;
      const next = completed('compose') && input.captions
        ? 'caption'
        : completed('slideshow')
        ? 'compose'
        : completed('speech') && input.scenes.every((_, i) => completed(`image-${i}`))
        ? 'slideshow'
        : undefined;
      if (next && !steps.some((s) => s.name === next)) {
        await repository.write(job.id, lease, next, 'pending');
        steps = await repository.steps(job.id);
      }
      if (signal.aborted) return job;
      const pending = steps.filter((s) => s.state === 'pending');
      const references = pending.some((s) => s.name.startsWith('image-'))
        ? await this.validateReferences(input, false)
        : [];
      const url = async (file: StoredMedia) => await artifacts.signedUrl(file.path, signal);
      // Prepare all inputs before claiming a provider dispatch, so signing errors can retry.
      const prepared = await Promise.all(pending.map(async (step) => {
        let body: Record<string, unknown>;
        if (step.name.startsWith('image-')) {
          const roles = input.references.map((r, i) => {
            const guidance = r.role === 'person'
              ? 'Use for appearance and identity only when this scene includes that person.'
              : r.role === 'product'
              ? 'Use for the depicted product design, colors and materials.'
              : 'Use for visual style, lighting and palette.';
            return `Reference ${i + 1} (${r.role}): ${guidance}`;
          }).join('\n');
          body = {
            // The campaign brief can describe speech, editing and timing. Only
            // the self-contained scene belongs in the image model's request.
            prompt: `Create one still image in a vertical 9:16 frame.\n\nScene: ${
              input.scenes[Number(step.name.slice(6))]
            }\n\n${roles}\nUse references only for elements included in this scene. Render lettering only when explicitly requested in the scene; do not add other text or watermarks.`,
            num_images: 1,
            aspect_ratio: '9:16',
            output_format: 'png',
            limit_generations: true,
            sync_mode: false,
            ...(references.length ? { image_urls: references, resolution: '1K' } : {}),
          };
        } else if (step.name === 'speech') {
          body = providerInput(SPEECH_SERVICE, { text: input.narration, voice: input.voice });
        } else if (step.name === 'slideshow') {
          const images = input.scenes.map((_, i) => completed(`image-${i}`)!);
          if (images.some((i) => i.width !== images[0].width || i.height !== images[0].height)) {
            return { step, error: true as const };
          }
          const durations = sceneDurations(completed('speech')!.duration!, images.length);
          body = providerInput(SLIDESHOW_SERVICE, {
            images: await Promise.all(
              images.map(async (image, i) => ({ url: await url(image), duration_seconds: durations[i] })),
            ),
          });
        } else if (step.name === 'compose') {
          body = providerInput(COMPOSE_SERVICE, {
            video_url: await url(completed('slideshow')!),
            audio_url: await url(completed('speech')!),
          });
        } else {body = providerInput(getService('video.caption')!, {
            video_url: await url(completed('compose')!),
          });}
        return { step, body };
      }));
      if (prepared.some((p) => p.error)) {
        return await store.failJob(
          job.id,
          'image-size-mismatch',
          'Generated scenes have inconsistent dimensions.',
        );
      }
      // A single paid request starts all images and narration concurrently.
      const dispatches = await Promise.allSettled(prepared.map(async ({ step, body }) => {
        await repository.write(job.id, lease, step.name, 'submitting');
        try {
          const accepted = await fal.submit(
            body!,
            `${this.d.baseUrl}/webhooks/fal`,
            targetFor(step.name, references.length > 0),
          );
          await repository.write(job.id, lease, step.name, 'queued', accepted.requestId);
        } catch (error) {
          await repository.write(
            job.id,
            lease,
            step.name,
            error instanceof FalSubmissionError && error.outcome === 'rejected' ? 'failed' : 'uncertain',
          );
        }
      }));
      if (dispatches.some((r) => r.status === 'rejected')) throw new Error('Step persistence unavailable');
    } catch {
      // Transport/storage failures resume from persisted queue IDs on the next tick.
    } finally {
      await store.releaseCompletion(job.id, lease);
    }
    return (await store.get(job.id)) ?? job;
  }
}
