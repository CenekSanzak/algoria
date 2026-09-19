import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { algoriaHome } from './stellar/keystore.mjs';
import { withLock } from './lock.mjs';
import { readLedger } from './services/state.mjs';
import { displayAmount } from './services/policy.mjs';

/** @typedef {{scope: string, key: string, value: string, updatedAt: string}} Note */
/** @typedef {{source: string, service: string, name: string, url: string | null, note: string, updatedAt: string}} SavedService */
/** @typedef {{version: number, notes: Note[], services: SavedService[]}} Memory */
export const memoryPath = () => join(algoriaHome(), 'memory.json');

/** @param {unknown} value @param {string} label @param {number} [max] */
function text(value, label, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) {
    throw new Error(`${label} must be non-empty text of at most ${max} characters`);
  }
  return value.trim();
}

/** @returns {Promise<Memory>} */
export async function readMemory() {
  let raw;
  try { raw = await readFile(memoryPath(), 'utf8'); }
  catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return { version: 1, notes: [], services: [] };
    throw error;
  }
  const state = JSON.parse(raw);
  if (state.version !== 1 || !Array.isArray(state.notes) || !Array.isArray(state.services)) {
    throw new Error('invalid memory file; preserve it instead of overwriting');
  }
  return state;
}

/** @template T @param {(state: Memory) => T} change */
async function editMemory(change) {
  return withLock('memory', async () => {
    const state = await readMemory();
    const result = change(state);
    await mkdir(algoriaHome(), { recursive: true, mode: 0o700 });
    await chmod(algoriaHome(), 0o700);
    const temp = `${memoryPath()}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temp, memoryPath());
    return result;
  });
}

/** @param {string} scope @param {string} key @param {string} value */
export async function remember(scope, key, value) {
  const note = { scope: text(scope, 'scope'), key: text(key, 'key'), value: text(value, 'value', 2000), updatedAt: new Date().toISOString() };
  return editMemory((state) => {
    state.notes = state.notes.filter((n) => n.scope !== note.scope || n.key !== note.key);
    state.notes.push(note);
    return note;
  });
}

/** @param {string} scope @param {string} key */
export async function forget(scope, key) {
  text(scope, 'scope'); text(key, 'key');
  return editMemory((state) => {
    const before = state.notes.length;
    state.notes = state.notes.filter((n) => n.scope !== scope || n.key !== key);
    return { removed: before - state.notes.length };
  });
}

/** A bookmark is not a payment target or a claim of integration support.
 * @param {{source: string, service: string, name?: string, url?: string, note?: string}} input
 */
export async function saveService({ source, service, name = service, url, note = '' }) {
  source = text(source, 'source'); service = text(service, 'service');
  let endpoint = null;
  if (url) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('bookmark URL must be HTTPS without credentials, query parameters or fragment; never save signed media URLs');
    }
    endpoint = parsed.href;
  }
  const saved = { source, service, name: text(name, 'name'), url: endpoint, note: note ? text(note, 'note', 2000) : '', updatedAt: new Date().toISOString() };
  return editMemory((state) => {
    state.services = state.services.filter((s) => s.source !== source || s.service !== service);
    state.services.push(saved);
    return saved;
  });
}

/** @param {string} source @param {string} service */
export async function forgetService(source, service) {
  text(source, 'source'); text(service, 'service');
  return editMemory((state) => {
    const before = state.services.length;
    state.services = state.services.filter((s) => s.source !== source || s.service !== service);
    return { removed: before - state.services.length };
  });
}

/** Local-only context, deliberately excluding prompts, outputs, signed URLs,
 * recovery tokens, authorizations and wallet secrets from the ledger.
 * @param {{scope?: string, query?: string, limit?: number}} [options]
 */
export async function recall({ scope, query = '', limit = 20 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be 1–100');
  const memory = await readMemory();
  const ledger = await readLedger();
  const history = Object.values(ledger.jobs).map((job) => ({
    id: job.id, source: job.source ?? 'algoria', service: job.service,
    budget: job.budget, status: job.status,
    charged: job.payment?.success === true ? displayAmount((job.offer ?? job.expectedOffer).amount) : null,
    unit: 'test USDC', updatedAt: job.updatedAt ?? job.createdAt ?? null,
    recoverable: job.source !== 'stellar8004',
    requiresAttention: job.phase === 'uncertain' || String(job.status).endsWith('-uncertain')
  })).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const needle = query.toLocaleLowerCase();
  /** @param {unknown} item */
  const matches = (item) => JSON.stringify(item).toLocaleLowerCase().includes(needle);
  const notes = memory.notes.filter((n) => (!scope || n.scope === scope || n.scope === 'user') && matches(n));
  const services = memory.services.filter(matches);
  const jobs = history.filter(matches);
  return {
    notes: notes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit),
    services: services.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit),
    history: jobs.slice(0, limit),
    totals: { notes: notes.length, services: services.length, history: jobs.length },
    historyScope: 'all local jobs; scope filters notes only',
    authority: 'Context only. Recheck current service terms and spending authorization; memory never grants payment permission.'
  };
}
