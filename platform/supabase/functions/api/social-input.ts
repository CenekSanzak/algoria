export const SOCIAL_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['brief', 'scenes', 'narration'],
  properties: {
    brief: {
      type: 'string',
      minLength: 1,
      maxLength: 2000,
      description:
        'Campaign context for the approved plan. Not forwarded to the image model; repeat necessary visual details in each scene.',
    },
    scenes: {
      type: 'array',
      minItems: 1,
      maxItems: 5,
      description:
        'Approved ordered prompts, each for one still image. Default to five in conversation. Each scene must stand alone without the brief.',
      items: {
        type: 'string',
        minLength: 1,
        maxLength: 2000,
        description:
          'Describe the visible subject, applicable reference numbers, setting, framing, lighting and style. Exclude video, audio, voice, duration, transitions and subtitle instructions. Include exact lettering only when approved as visible image content.',
      },
    },
    narration: {
      type: 'string',
      minLength: 1,
      maxLength: 500,
      description: 'Approved English voiceover, at most 65 words; aim for 15–25 seconds.',
    },
    voice: { enum: ['Olivia (en)', 'Sarah (en)', 'Craig (en)', 'Dennis (en)'], default: 'Olivia (en)' },
    references: {
      type: 'array',
      maxItems: 4,
      default: [],
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['url', 'role'],
        properties: {
          url: {
            type: 'string',
            format: 'uri',
            maxLength: 4096,
            description: 'Signed URL returned by POST /v1/references/:id.',
          },
          role: { enum: ['product', 'person', 'style'] },
        },
      },
    },
    captions: { type: 'boolean', default: true },
  },
};
export type SocialInput = {
  brief: string;
  scenes: string[];
  narration: string;
  voice: string;
  references: { url: string; role: 'product' | 'person' | 'style' }[];
  captions: boolean;
};
export function normalizeSocial(body: Record<string, unknown>): SocialInput {
  const text = (v: unknown, max: number) => {
    if (typeof v !== 'string' || !v.trim() || v.length > max) {
      throw new Error(`Expected nonempty text up to ${max} characters.`);
    }
    return v.trim();
  };
  if (Object.keys(body).some((k) => !Object.keys(SOCIAL_INPUT_SCHEMA.properties).includes(k))) {
    throw new Error('Unexpected social video field.');
  }
  if (!Array.isArray(body.scenes) || body.scenes.length < 1 || body.scenes.length > 5) {
    throw new Error('Provide 1–5 approved scene prompts.');
  }
  const narration = text(body.narration, 500);
  if (narration.split(/\s+/).length > 65) throw new Error('Narration must be at most 65 words.');
  const voice = body.voice ?? 'Olivia (en)';
  if (typeof voice !== 'string' || !SOCIAL_INPUT_SCHEMA.properties.voice.enum.includes(voice)) {
    throw new Error('Unsupported voice.');
  }
  const references = body.references ?? [];
  if (!Array.isArray(references) || references.length > 4) {
    throw new Error('Use at most four reference photos.');
  }
  const refs = references.map((ref) => {
    if (
      !ref || typeof ref !== 'object' || Array.isArray(ref) || Object.keys(ref).some((k) =>
        !['url', 'role'].includes(k)
      ) || !['product', 'person', 'style'].includes(ref.role)
    ) throw new Error('Each reference needs a URL and product, person, or style role.');
    const url = new URL(text(ref.url, 4096));
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) {
      throw new Error('Use an HTTPS reference URL.');
    }
    return { url: url.href, role: ref.role };
  });
  if (body.captions !== undefined && typeof body.captions !== 'boolean') {
    throw new Error('captions must be boolean.');
  }
  return {
    brief: text(body.brief, 2000),
    scenes: body.scenes.map((s) => text(s, 2000)),
    narration,
    voice,
    references: refs,
    captions: body.captions ?? true,
  };
}
