// Shared with the native transaction builder. Never accept arbitrary endpoints
// or caller-authored review labels for a paid service.
const base = 'https://vqqbvydiehuwdzbgvmun.supabase.co/functions/v1/api/v1/services/';
export const TEMPO_SERVICES = ['image.generate', 'phone.call', 'video.social'];
/** @param {string} service */
export function tempoResource(service) {
  if (!TEMPO_SERVICES.includes(service)) throw new Error('Unsupported Tempo service');
  return base + service;
}
/** Canonical order/defaults must match the backend's input hash.
 * @param {string} service @param {any} input */
export function normalizeTempoInput(service, input) {
  tempoResource(service);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Provide a JSON object');
  if (service === 'image.generate') {
    if (Object.keys(input).length !== 1 || typeof input.prompt !== 'string' ||
        !input.prompt.trim() || input.prompt.length > 4000) throw new Error('An image task needs one prompt, at most 4000 characters');
    return { prompt: input.prompt.trim() };
  }
  if (service === 'video.social') {
    // Keep field order, trimming and defaults identical to normalizeSocial on
    // the backend. The native builder hashes and reviews this exact object.
    const text = (/** @type {any} */ value, /** @type {number} */ max) => {
      if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Expected nonempty text up to ${max} characters`);
      return value.trim();
    };
    if (Object.keys(input).some(k => !['brief', 'scenes', 'narration', 'voice', 'references', 'captions'].includes(k))) throw new Error('Unexpected social video field');
    if (!Array.isArray(input.scenes) || input.scenes.length < 1 || input.scenes.length > 5) throw new Error('Provide 1–5 approved scene prompts');
    const narration = text(input.narration, 500);
    if (narration.split(/\s+/).length > 65) throw new Error('Narration must be at most 65 words');
    const voice = input.voice ?? 'Olivia (en)';
    if (!['Olivia (en)', 'Sarah (en)', 'Craig (en)', 'Dennis (en)'].includes(voice)) throw new Error('Unsupported voice');
    const references = input.references ?? [];
    if (!Array.isArray(references) || references.length > 4) throw new Error('Use at most four reference photos');
    const refs = references.map((/** @type {any} */ ref) => {
      if (!ref || typeof ref !== 'object' || Array.isArray(ref) ||
          Object.keys(ref).some(k => !['url', 'role'].includes(k)) ||
          !['product', 'person', 'style'].includes(ref.role)) throw new Error('Each reference needs a URL and product, person, or style role');
      // Accept only canonical signed capabilities from our upload helper.
      // JavaScriptCore has no browser URL global. The backend separately
      // validates admission/access before quoting and re-signs stored paths.
      const url = text(ref.url, 4096);
      if (!/^https:\/\/vqqbvydiehuwdzbgvmun\.supabase\.co\/storage\/v1\/object\/sign\/outputs\/references\/[0-9a-f-]{36}\/[0-9a-f]{64}\.(png|jpg|webp)\?token=[A-Za-z0-9_.-]+$/.test(url)) throw new Error('Use a signed Algoria reference-upload URL');
      return { url, role: ref.role };
    });
    if (input.captions !== undefined && typeof input.captions !== 'boolean') throw new Error('captions must be boolean');
    return { brief: text(input.brief, 2000), scenes: input.scenes.map((/** @type {any} */ scene) => text(scene, 2000)),
      narration, voice, references: refs, captions: input.captions ?? true };
  }
  if (Object.keys(input).some(k => !['contact', 'goal', 'on_behalf_of', 'language'].includes(k))) throw new Error('Unexpected phone call fields');
  const contact = typeof input.contact === 'string' ? input.contact.trim().toLowerCase() : '';
  const onBehalfOf = input.on_behalf_of ?? 'an Algoria user';
  const language = input.language ?? 'en';
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(contact) || typeof input.goal !== 'string' ||
      !input.goal.trim() || input.goal.length > 1000 || typeof onBehalfOf !== 'string' ||
      !onBehalfOf.trim() || onBehalfOf.length > 80 || !['en', 'tr'].includes(language)) throw new Error('Invalid phone call input');
  return { contact, goal: input.goal.trim(), on_behalf_of: onBehalfOf.trim(), language };
}
