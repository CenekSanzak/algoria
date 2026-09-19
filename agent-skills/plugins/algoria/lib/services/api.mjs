export const API_BASE = 'https://vqqbvydiehuwdzbgvmun.supabase.co/functions/v1/api';

/** Only this platform's paths may receive recovery/payment credentials.
 * @param {string} service
 */
export function serviceUrl(service) {
  if (!/^[a-z][a-z0-9.-]{0,100}$/.test(service)) throw new Error('invalid service id');
  return `${API_BASE}/v1/services/${service}`;
}

/** @param {string} id */
export function jobUrl(id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw new Error('invalid job UUID');
  return `${API_BASE}/v1/jobs/${id}`;
}

/** No automatic redirects/retries: a lost POST must be recovered by job ID.
 * @param {string} url
 * @param {RequestInit} [options]
 * @param {number} [timeoutMs]
 */
export async function apiFetch(url, options = {}, timeoutMs = 60_000) {
  if (!url.startsWith(`${API_BASE}/`) || new URL(url).origin !== new URL(API_BASE).origin) {
    throw new Error('untrusted Algoria API URL');
  }
  let response;
  let body;
  try {
    response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    body = await response.json();
  } catch {
    throw new Error('Algoria response unavailable; recover the saved job instead of starting a new payment');
  }
  return { response, body };
}

/** Do not echo server messages that could contain headers or secrets.
 * @param {Response} response @param {any} body
 */
export function apiError(response, body) {
  const code = typeof body?.code === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(body.code) ? body.code : 'request-failed';
  return new Error(`Algoria HTTP ${response.status}: ${code}`);
}
