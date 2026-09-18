import type { Artifacts } from './artifacts.ts';
import { compositionDuration, type Scene, type Service, type ServiceInput } from './catalog.ts';
import { HttpError, validId } from './security.ts';
import type { Store } from './store.ts';

type SourceKind = 'image' | 'audio' | 'video';
type SourceDependencies = {
  supabaseUrl: string;
  store: Pick<Store, 'get'>;
  artifacts: Artifacts;
};

/** A signed output URL is the source capability. Validate it before issuing a
 * paid quote; after acceptance, refresh that same immutable source for fal.
 * Restrict the first video release to our own bounded, completed outputs.
 */
export async function resolveSources(
  service: Service,
  input: ServiceInput,
  dependencies: SourceDependencies,
  verifyAccess: boolean,
): Promise<ServiceInput> {
  if (!['video.slideshow', 'video.compose', 'video.caption'].includes(service.id)) return input;
  const base = new URL(dependencies.supabaseUrl);
  async function source(value: string, kind: SourceKind, allowedService: string) {
    const url = new URL(value);
    const prefix = '/storage/v1/object/sign/outputs/';
    if (url.origin !== base.origin || !url.pathname.startsWith(prefix) || !url.searchParams.get('token')) {
      throw new HttpError(
        400,
        'invalid-source',
        'Use a current signed output URL from a completed Algoria job.',
      );
    }
    let path;
    try {
      path = decodeURIComponent(url.pathname.slice(prefix.length));
    } catch {
      throw new HttpError(400, 'invalid-source');
    }
    const parts = path.split('/');
    if (parts.length !== 2 || !validId(parts[0])) throw new HttpError(400, 'invalid-source');
    const job = await dependencies.store.get(parts[0]);
    if (
      !job || job.status !== 'succeeded' || job.service_id !== allowedService || job.output?.path !== path
    ) {
      throw new HttpError(
        400,
        'invalid-source',
        'The source must be a completed Algoria output of the expected type.',
      );
    }
    const file = job.output;
    if (
      kind !== 'image' &&
      (typeof file.duration !== 'number' || !Number.isFinite(file.duration) || file.duration <= 0 ||
        file.duration > 30.05)
    ) {
      throw new HttpError(
        400,
        'source-duration-limit',
        'Video workflows require narration and video of at most 30 seconds.',
      );
    }
    if (
      kind === 'image' &&
      (typeof file.width !== 'number' || !Number.isInteger(file.width) || file.width <= 0 ||
        typeof file.height !== 'number' || !Number.isInteger(file.height) || file.height <= 0 ||
        file.width > 2048 || file.height > 2048)
    ) {
      throw new HttpError(
        400,
        'source-image-limit',
        'Use an Algoria image with dimensions at most 2048 by 2048.',
      );
    }
    if (verifyAccess) {
      let response;
      try {
        response = await fetch(url, { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(8000) });
      } catch {
        throw new HttpError(
          503,
          'source-unavailable',
          'The source could not be checked. Retry without paying.',
        );
      }
      if (!response.ok) {
        throw new HttpError(
          response.status >= 500 ? 503 : 400,
          'source-unavailable',
          'Refresh the source job output URL before creating a new request.',
        );
      }
      const type = response.headers.get('content-type')?.split(';')[0];
      const length = Number(response.headers.get('content-length'));
      const maxBytes = kind === 'image'
        ? 10 * 1024 * 1024
        : kind === 'audio'
        ? 20 * 1024 * 1024
        : 40 * 1024 * 1024;
      if (!type?.startsWith(`${kind}/`) || !Number.isFinite(length) || length <= 0 || length > maxBytes) {
        throw new HttpError(400, 'source-size-or-type', 'The source is not a supported bounded media file.');
      }
    }
    return { url: verifyAccess ? value : await dependencies.artifacts.signedUrl(path), file };
  }
  if (service.id === 'video.caption') {
    const video = await source(input.video_url as string, 'video', 'video.compose');
    return { video_url: video.url };
  }
  if (service.id === 'video.compose' && service.version !== '1') {
    const [video, audio] = await Promise.all([
      source(input.video_url as string, 'video', 'video.slideshow'),
      source(input.audio_url as string, 'audio', 'speech.generate'),
    ]);
    if (Number(audio.file.duration) > Number(video.file.duration) + 0.05) {
      throw new HttpError(
        400,
        'narration-too-long',
        'The slideshow duration must cover the audio duration returned by speech.generate.',
      );
    }
    return { video_url: video.url, audio_url: audio.url };
  }
  const scenes = input.images as Scene[];
  const [images, audio] = await Promise.all([
    Promise.all(scenes.map(async (scene) => ({
      ...scene,
      source: await source(scene.url, 'image', 'image.generate'),
    }))),
    service.id === 'video.compose'
      ? source(input.audio_url as string, 'audio', 'speech.generate')
      : Promise.resolve(undefined),
  ]);
  if (audio && Number(audio.file.duration) > compositionDuration(input) + 0.05) {
    throw new HttpError(
      400,
      'narration-too-long',
      'Scene durations must cover the audio duration returned by speech.generate.',
    );
  }
  const first = images[0].source.file;
  if (images.some(({ source }) => source.file.width !== first.width || source.file.height !== first.height)) {
    throw new HttpError(400, 'image-size-mismatch', 'All slideshow images must have matching dimensions.');
  }
  return {
    images: images.map(({ source, duration_seconds }) => ({ url: source.url, duration_seconds })),
    ...(audio ? { audio_url: audio.url } : {}),
  };
}
