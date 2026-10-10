/** A single public task card. No guessed progress percentages or signing authority.
 * @param {any} job @param {number} [now]
 */
export function journeyFor(job, now = Date.now()) {
  const elapsedSeconds = Math.max(0, Math.floor((now - Date.parse(job.createdAt)) / 1000)) || 0;
  const base = { taskId: job.id, elapsedSeconds, paymentConfirmed: job.payment?.success === true };
  const card = (/** @type {string} */ stage, /** @type {string} */ message, /** @type {string} */ nextAction) => ({ ...base, stage, message, nextAction });
  if (job.phase === 'uncertain' || String(job.status).endsWith('-uncertain')) return card('needs-attention', 'Payment or execution needs reconciliation. Keep this task; do not pay again.', 'recover');
  if (job.status === 'failed') return card('failed', base.paymentConfirmed ? 'The service failed after payment. Your receipt is saved; no refund is implied.' : 'The task failed. Check its saved details before deciding what to do next.', 'review-error');
  if (job.status === 'succeeded') return card('ready', job.service === 'phone.call' ? 'The call is finished. Show its summary and transcript; do not redial to recover this result.' : 'Your result is ready. Open it in the conversation; refresh this same task if access expires.', 'open-result');
  if (job.uxStage === 'queued-approval') return card('queued-approval', 'Waiting for the current wallet approval to finish.', 'wait');
  if (job.uxStage === 'funding') return card('funding', 'Preparing a disposable wallet with Tempo testnet faucet tokens. No real funds.', 'wait');
  if (job.uxStage === 'funding-needed') return card('funding-needed', 'The wallet needs test PathUSD. See its exact top-up amount and address in the open local wallet, then check its balance. Never send real funds.', 'top-up-in-wallet');
  if (job.uxStage === 'review') return card('review', 'Review this exact purchase in the local wallet, then approve with Touch ID.', 'approve-in-wallet');
  if (job.dispatchedAt && job.status === 'awaiting_payment') return card('confirming-payment', 'Checking the saved transaction. A second payment will not be signed.', 'recover');
  if (job.service === 'phone.call') {
    const calls = /** @type {Record<string, [string, string]>} */ ({
      paid: ['paid', 'Payment confirmed. Resume this same call job; do not create another call.'],
      submitting: ['starting', 'Starting the approved real call. Do not redial if the response is delayed.'],
      queued: ['queued', 'The approved call is dialing or waiting to connect.'],
      running: ['calling', 'The AI call is in progress. Follow this same task for its outcome.'],
      saving: ['saving', 'Preparing the call summary and transcript.']
    });
    if (calls[job.status]) return card(...calls[job.status], job.status === 'paid' ? 'resume' : 'wait');
  }
  const states = /** @type {Record<string, [string, string]>} */ ({
    settling: ['confirming-payment', 'Confirming your payment.'],
    paid: ['paid', 'Payment confirmed. Resume generation using this same task.'],
    submitting: ['starting', 'Payment confirmed. Starting generation.'],
    queued: ['queued', 'The provider has queued your request.'],
    running: ['generating', 'The provider is generating your result.'],
    saving: ['saving', 'Saving the generated result.'],
    'result-ready': ['preparing-delivery', 'Generation is finished. Preparing result access.']
  });
  if (states[job.status]) return card(...states[job.status], job.status === 'paid' ? 'resume' : 'wait');
  if (job.expiresAt && Date.parse(job.expiresAt) <= now) return card('quote-expired', 'This quote expired. No new payment was attempted. Review new terms before a separate purchase.', 'review-expired-quote');
  return card(job.phase === 'prepared' ? 'preparing' : 'awaiting-approval', 'Your task is saved. Review its exact price and approve when ready.', job.phase === 'prepared' ? 'resume' : 'approve');
}
