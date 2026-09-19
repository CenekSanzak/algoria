import { API_BASE, apiError, apiFetch, serviceUrl } from './api.mjs';
import { validateOffer } from './policy.mjs';

/** @param {any} service */
export function validateService(service) {
  if (!service || service.method !== 'POST' || service.resource !== serviceUrl(service.id) ||
      typeof service.version !== 'string' || !service.input_schema || !service.output_schema ||
      !Array.isArray(service.accepts) || service.accepts.length !== 1) {
    throw new Error('unsupported Algoria service contract');
  }
  validateOffer(service.accepts[0]);
  return service;
}

/** @param {{query?: string, limit?: number, offset?: number}} [options] */
export async function discover({ query, limit = 20, offset = 0 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) throw new Error('invalid discovery pagination');
  const params = new URLSearchParams({ type: 'http', network: 'stellar:testnet', scheme: 'exact', limit: String(limit), offset: String(offset) });
  if (query) params.set('query', query);
  const { response, body } = await apiFetch(`${API_BASE}/discovery/resources?${params}`);
  if (!response.ok) throw apiError(response, body);
  if (body?.x402Version !== 2 || !Array.isArray(body.resources)) throw new Error('invalid discovery response');
  body.resources.forEach(validateService);
  return body;
}

/** @param {string} id */
export async function getService(id) {
  const { response, body } = await apiFetch(serviceUrl(id));
  if (!response.ok) throw apiError(response, body);
  if (body?.id !== id) throw new Error('service identity mismatch');
  return validateService(body);
}
