// Shared with the native transaction builder. Never accept arbitrary endpoints
// or caller-authored review labels for a paid service.
const base = 'https://vqqbvydiehuwdzbgvmun.supabase.co/functions/v1/api/v1/services/';
/** @param {string} service */
export function tempoResource(service) {
  if (!['image.generate', 'phone.call'].includes(service)) throw new Error('Unsupported Tempo service');
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
  if (Object.keys(input).some(k => !['contact', 'goal', 'on_behalf_of', 'language'].includes(k))) throw new Error('Unexpected phone call fields');
  const contact = typeof input.contact === 'string' ? input.contact.trim().toLowerCase() : '';
  const onBehalfOf = input.on_behalf_of ?? 'an Algoria user';
  const language = input.language ?? 'en';
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(contact) || typeof input.goal !== 'string' ||
      !input.goal.trim() || input.goal.length > 1000 || typeof onBehalfOf !== 'string' ||
      !onBehalfOf.trim() || onBehalfOf.length > 80 || !['en', 'tr'].includes(language)) throw new Error('Invalid phone call input');
  return { contact, goal: input.goal.trim(), on_behalf_of: onBehalfOf.trim(), language };
}
