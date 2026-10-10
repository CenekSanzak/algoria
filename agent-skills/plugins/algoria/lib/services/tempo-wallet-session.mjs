/** Read-only UI messages. No input, credentials, permissions or media URLs.
 * This session owns presentation only; closing it must never stop reconciliation.
 * @param {string} id @param {(message: any) => void} write @param {() => void} close
 */
export function walletSession(id, write, close) {
  let ended = false, last = '';
  const stages = new Set(['confirming-payment', 'paid', 'starting', 'queued', 'generating',
    'calling', 'saving', 'preparing-delivery', 'ready', 'failed', 'needs-attention']);
  /** @param {any} job @param {boolean} [finishing] */
  const present = (job, finishing = false) => {
    if (ended || job?.id !== id) return;
    let stage = job.requiresAttention ? 'needs-attention' : job.journey?.stage;
    if (!stages.has(stage)) stage = 'confirming-payment';
    if (stage === 'paid' && job.payment?.success !== true) stage = 'confirming-payment';
    if (finishing && !['ready', 'failed', 'needs-attention', 'paid'].includes(stage)) stage = 'paused';
    const transaction = typeof job.transactionUrl === 'string'
      ? /^https:\/\/explore\.testnet\.tempo\.xyz\/tx\/(0x[0-9a-fA-F]{64})$/.exec(job.transactionUrl)?.[1] : undefined;
    const message = { type: 'wallet-progress', stage, ...(transaction ? { transaction } : {}) };
    const serialized = JSON.stringify(message);
    if (last === serialized) return;
    last = serialized;
    try { write(message); } catch { /* Presentation cannot alter payment state. */ }
  };
  return {
    update: present,
    /** @param {any} job */
    finish(job) {
      if (ended) return;
      present(job, true); ended = true;
      try { close(); } catch { /* A closed window is not a failed purchase. */ }
    },
  };
}
