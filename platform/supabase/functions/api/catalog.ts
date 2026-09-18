import type { Config } from './config.ts';

export type ServiceId =
  | 'image.generate'
  | 'speech.generate'
  | 'video.slideshow'
  | 'video.compose'
  | 'video.caption';
export type ServiceInput = Record<string, unknown>;
export interface Service {
  id: ServiceId;
  version: string;
  name: string;
  description: string;
  tags: string[];
  inputSchema: Record<string, unknown>;
  exampleInput: ServiceInput;
  outputKind: 'images' | 'audio' | 'video';
  providerOutput: 'images' | 'audio' | 'video' | 'video_url';
  model: string;
  queuePath: string;
}

export const SPEECH_VOICES = ['Craig (en)', 'Olivia (en)', 'Dennis (en)', 'Sarah (en)'] as const;
export const INPUT_SCHEMA = {
  type: 'object',
  properties: { prompt: { type: 'string', minLength: 1, maxLength: 4000 } },
  required: ['prompt'],
  additionalProperties: false,
};
export const SPEECH_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', minLength: 1, maxLength: 1000, description: 'English text to narrate.' },
    voice: { type: 'string', enum: [...SPEECH_VOICES], default: 'Craig (en)' },
  },
  required: ['text'],
  additionalProperties: false,
};

const mediaUrlSchema = {
  type: 'string',
  format: 'uri',
  maxLength: 4096,
  description: 'A current signed output URL from a completed Algoria job. External uploads are not accepted.',
};
const sceneListSchema = {
  type: 'array',
  minItems: 1,
  maxItems: 6,
  description: 'Ordered still images of matching dimensions; total duration must be 1–30 seconds.',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['url', 'duration_seconds'],
    properties: { url: mediaUrlSchema, duration_seconds: { type: 'number', minimum: 0.5, maximum: 30 } },
  },
};
export const SLIDESHOW_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['images'],
  properties: { images: sceneListSchema },
};
export const LEGACY_COMPOSE_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['images', 'audio_url'],
  properties: {
    images: {
      ...sceneListSchema,
      description: 'Ordered still images; total duration must be 1–30 seconds and cover the narration.',
    },
    audio_url: mediaUrlSchema,
  },
};
export const COMPOSE_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['video_url', 'audio_url'],
  properties: {
    video_url: {
      ...mediaUrlSchema,
      description: 'Signed URL of a completed Algoria video.slideshow result, at most 30 seconds.',
    },
    audio_url: {
      ...mediaUrlSchema,
      description: 'Signed URL of a completed Algoria speech.generate result, no longer than the slideshow.',
    },
  },
};
export const CAPTION_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['video_url'],
  properties: {
    video_url: {
      ...mediaUrlSchema,
      description: 'Signed URL of an Algoria video.compose result, at most 30 seconds, with narration.',
    },
  },
};

export const LEGACY_COMPOSE_SERVICE: Service = {
  id: 'video.compose',
  version: '1',
  name: 'Algoria Video Composition',
  description:
    'Combine 1–6 Algoria images and an Algoria narration into a 1–30 second MP4 slideshow. Scene durations must cover the audio.',
  tags: ['video', 'compose', 'slideshow', 'advertisement', 'reel', 'voiceover'],
  inputSchema: LEGACY_COMPOSE_INPUT_SCHEMA,
  exampleInput: {
    images: [{ url: 'https://storage.example.com/image.png?token=example', duration_seconds: 20 }],
    audio_url: 'https://storage.example.com/audio.wav?token=example',
  },
  outputKind: 'video',
  providerOutput: 'video_url',
  model: 'fal-ai/ffmpeg-api/compose',
  queuePath: 'fal-ai/ffmpeg-api',
};

export const SERVICES: Service[] = [
  {
    id: 'image.generate' as const,
    version: '1',
    name: 'Algoria Image Generation',
    description: 'Generate one square 1K PNG image from a text prompt.',
    tags: ['image', 'generation', 'design', 'art', 'visual'],
    inputSchema: INPUT_SCHEMA,
    exampleInput: { prompt: 'A small red sailboat on a calm turquoise sea, watercolor illustration.' },
    outputKind: 'images' as const,
    providerOutput: 'images',
    model: 'google/nano-banana-2-lite',
    queuePath: 'google/nano-banana-2-lite',
  },
  {
    id: 'speech.generate' as const,
    version: '1',
    name: 'Algoria Text to Speech',
    description: 'Turn up to 1000 characters of English text into WAV narration using a preset voice.',
    tags: ['audio', 'speech', 'tts', 'narration', 'voiceover', 'text-to-speech'],
    inputSchema: SPEECH_INPUT_SCHEMA,
    exampleInput: {
      text: 'Meet Algoria. Your agent can discover useful services and pay as it goes.',
      voice: 'Craig (en)',
    },
    outputKind: 'audio' as const,
    providerOutput: 'audio',
    model: 'fal-ai/inworld-tts',
    queuePath: 'fal-ai/inworld-tts',
  },
  {
    id: 'video.slideshow',
    version: '1',
    name: 'Algoria Video Slideshow',
    description:
      'Sequence 1–6 Algoria images of matching dimensions into a silent 1–30 second MP4 slideshow.',
    tags: ['video', 'slideshow', 'sequence', 'advertisement', 'reel'],
    inputSchema: SLIDESHOW_INPUT_SCHEMA,
    exampleInput: {
      images: [{ url: 'https://storage.example.com/image.png?token=example', duration_seconds: 20 }],
    },
    outputKind: 'video',
    providerOutput: 'video',
    model: 'fal-ai/ffmpeg-api/images-to-video',
    queuePath: 'fal-ai/ffmpeg-api',
  },
  {
    id: 'video.compose',
    version: '2',
    name: 'Algoria Video Composition',
    description:
      'Add an Algoria narration to a completed Algoria video.slideshow result of at most 30 seconds. The video must cover the audio.',
    tags: ['video', 'compose', 'audio', 'advertisement', 'reel', 'voiceover'],
    inputSchema: COMPOSE_INPUT_SCHEMA,
    exampleInput: {
      video_url: 'https://storage.example.com/slideshow.mp4?token=example',
      audio_url: 'https://storage.example.com/audio.wav?token=example',
    },
    outputKind: 'video',
    providerOutput: 'video',
    model: 'fal-ai/ffmpeg-api/merge-audio-video',
    queuePath: 'fal-ai/ffmpeg-api',
  },
  {
    id: 'video.caption',
    version: '1',
    name: 'Algoria Video Captions',
    description:
      'Add animated English subtitles to a narrated Algoria video.compose result of at most 30 seconds.',
    tags: ['video', 'caption', 'subtitle', 'accessibility', 'advertisement'],
    inputSchema: CAPTION_INPUT_SCHEMA,
    exampleInput: { video_url: 'https://storage.example.com/video.mp4?token=example' },
    outputKind: 'video',
    providerOutput: 'video',
    model: 'fal-ai/workflow-utilities/auto-subtitle',
    queuePath: 'fal-ai/workflow-utilities',
  },
];
export const IMAGE_SERVICE = SERVICES[0];
export const SPEECH_SERVICE = SERVICES[1];
export const SLIDESHOW_SERVICE = SERVICES[2];
export const COMPOSE_SERVICE = SERVICES[3];

export function getService(id: string, version?: string): Service | undefined {
  if (id === LEGACY_COMPOSE_SERVICE.id && version === LEGACY_COMPOSE_SERVICE.version) {
    return LEGACY_COMPOSE_SERVICE;
  }
  return SERVICES.find((service) =>
    service.id === id && (version === undefined || service.version === version)
  );
}

export function servicePayment(config: Config, id: ServiceId) {
  return id === 'image.generate'
    ? { payTo: config.imagePayTo, priceAtomic: config.priceAtomic }
    : config.servicePayments?.[id];
}
export const enabledServices = (config: Config) => SERVICES.filter((s) => servicePayment(config, s.id));

export function normalizeInput(service: Service, body: unknown): ServiceInput {
  if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error('Provide a JSON object.');
  const value = body as Record<string, unknown>;
  if (service.id === 'image.generate') {
    if (
      Object.keys(value).some((key) => key !== 'prompt') || typeof value.prompt !== 'string' ||
      !value.prompt.trim() || value.prompt.length > 4000
    ) {
      throw new Error('Provide only prompt, a nonempty string of at most 4000 characters.');
    }
    return { prompt: value.prompt.trim() };
  }
  if (service.id === 'video.slideshow' || (service.id === 'video.compose' && service.version === '1')) {
    const legacyCompose = service.id === 'video.compose';
    const fields = legacyCompose ? ['images', 'audio_url'] : ['images'];
    if (
      Object.keys(value).some((key) => !fields.includes(key)) ||
      !Array.isArray(value.images) || value.images.length < 1 || value.images.length > 6
    ) {
      throw new Error(`Provide 1–6 images with duration_seconds${legacyCompose ? ' and an audio_url' : ''}.`);
    }
    const images = value.images.map((image) => {
      if (
        !image || typeof image !== 'object' || Array.isArray(image) ||
        Object.keys(image).some((key) => !['url', 'duration_seconds'].includes(key)) ||
        typeof image.duration_seconds !== 'number' || !Number.isFinite(image.duration_seconds) ||
        image.duration_seconds < 0.5 || image.duration_seconds > 30
      ) {
        throw new Error('Each image needs a URL and duration_seconds between 0.5 and 30.');
      }
      return {
        url: normalizeUrl(image.url),
        duration_seconds: Math.round(image.duration_seconds * 1000) / 1000,
      };
    });
    const duration = compositionDuration({ images });
    if (duration < 1 || duration > 30) throw new Error('Total video duration must be 1–30 seconds.');
    return legacyCompose ? { images, audio_url: normalizeUrl(value.audio_url) } : { images };
  }
  if (service.id === 'video.compose' && service.version === '2') {
    if (Object.keys(value).some((key) => !['video_url', 'audio_url'].includes(key))) {
      throw new Error('Provide only video_url and audio_url.');
    }
    return { video_url: normalizeUrl(value.video_url), audio_url: normalizeUrl(value.audio_url) };
  }
  if (service.id === 'video.caption') {
    if (Object.keys(value).some((key) => key !== 'video_url')) throw new Error('Provide only video_url.');
    return { video_url: normalizeUrl(value.video_url) };
  }
  if (
    Object.keys(value).some((key) => !['text', 'voice'].includes(key)) || typeof value.text !== 'string' ||
    !value.text.trim() || Array.from(value.text).length > 1000
  ) {
    throw new Error(
      'Provide text, a nonempty English string of at most 1000 characters, and an optional voice.',
    );
  }
  const voice = value.voice ?? 'Craig (en)';
  if (typeof voice !== 'string' || !(SPEECH_VOICES as readonly string[]).includes(voice)) {
    throw new Error('Select a voice from the service schema.');
  }
  return { text: value.text.trim(), voice };
}

function normalizeUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096) {
    throw new Error('Provide a signed Algoria output URL.');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid media URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port) {
    throw new Error('Use an HTTPS output URL.');
  }
  return url.href;
}

export type Scene = { url: string; duration_seconds: number };
export const compositionDuration = (input: ServiceInput) =>
  (input.images as Scene[]).reduce((sum, image) => sum + Math.round(image.duration_seconds * 1000), 0) / 1000;

export function providerInput(service: Service, input: ServiceInput): Record<string, unknown> {
  if (service.id === 'video.slideshow') {
    let elapsedMs = 0;
    let previousEndFrame = 0;
    const images = (input.images as Scene[]).map((image) => {
      elapsedMs += Math.round(image.duration_seconds * 1000);
      const endFrame = Math.ceil(elapsedMs * 24 / 1000);
      const frames = endFrame - previousEndFrame;
      previousEndFrame = endFrame;
      return { url: image.url, frames };
    });
    // The provider extends the tail from a preceding hold; one sentinel still overran.
    // Two same-image one-frame sentinels bounded the verified 408-frame request to
    // 409 output frames. Preserve the requested total; valid public scenes exceed two frames.
    const lastImage = images[images.length - 1];
    lastImage.frames -= 2;
    images.push({ url: lastImage.url, frames: 1 }, { url: lastImage.url, frames: 1 });
    return { images, fps: 24 };
  }
  if (service.id === 'video.compose' && service.version === '2') {
    return { video_url: input.video_url, audio_url: input.audio_url, start_offset: 0 };
  }
  if (service.id === 'video.compose' && service.version === '1') {
    let timestamp = 0;
    const keyframes = (input.images as Scene[]).map((image) => {
      const frame = { url: image.url, timestamp, duration: Math.round(image.duration_seconds * 1000) };
      timestamp += frame.duration;
      return frame;
    });
    return {
      tracks: [
        { id: 'visuals', type: 'image', keyframes },
        {
          id: 'narration',
          type: 'audio',
          keyframes: [{ url: input.audio_url, timestamp: 0, duration: timestamp }],
        },
      ],
    };
  }
  if (service.id === 'video.caption') {
    return {
      video_url: input.video_url,
      language: 'en',
      font_name: 'Montserrat',
      font_size: 56,
      font_weight: 'bold',
      font_color: 'white',
      highlight_color: 'yellow',
      position: 'bottom',
      y_offset: -40,
      words_per_subtitle: 3,
      enable_animation: true,
    };
  }
  return service.id === 'image.generate'
    ? {
      prompt: input.prompt,
      num_images: 1,
      aspect_ratio: '1:1',
      output_format: 'png',
      limit_generations: true,
      sync_mode: false,
    }
    : { text: input.text, voice: input.voice, sample_rate_hertz: 24000 };
}
