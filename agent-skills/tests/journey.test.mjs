import { describe, expect, it } from 'vitest';
import { journeyFor } from '../plugins/algoria/lib/services/journey.mjs';
describe('durable task presentation', () => {
  it('describes real calls and transcript delivery without pretending to generate media', () => {
    expect(journeyFor({ service: 'phone.call', status: 'running' })).toMatchObject({ stage: 'calling', nextAction: 'wait' });
    expect(journeyFor({ service: 'phone.call', status: 'paid' }).message).toContain('same call job');
    expect(journeyFor({ service: 'phone.call', status: 'succeeded' }).message).toContain('summary and transcript');
    expect(journeyFor({ service: 'phone.call', status: 'submission-uncertain' }).nextAction).toBe('recover');
  });
  it.each([
    ['settling', 'confirming-payment'], ['paid', 'paid'], ['submitting', 'starting'],
    ['queued', 'queued'], ['running', 'generating'], ['saving', 'saving'],
    ['result-ready', 'preparing-delivery'], ['succeeded', 'ready'], ['failed', 'failed']
  ])('maps real %s status without invented percentages', (status, stage) => {
    const card = journeyFor({ id: 'task', status, createdAt: '2026-10-05T00:00:00Z' }, Date.parse('2026-10-05T00:00:12Z'));
    expect(card.stage).toBe(stage); expect(card.elapsedSeconds).toBe(12);
    expect(card).not.toHaveProperty('percent');
  });
  it('prioritizes uncertain settlement over stale wallet progress or success', () => {
    expect(journeyFor({ phase: 'uncertain', status: 'succeeded', uxStage: 'review' }).nextAction).toBe('recover');
    expect(journeyFor({ status: 'awaiting_payment', uxStage: 'queued-approval' }).stage).toBe('queued-approval');
    expect(journeyFor({ status: 'awaiting_payment', uxStage: 'funding' }).stage).toBe('funding');
    expect(journeyFor({ status: 'awaiting_payment', uxStage: 'funding-needed' }).nextAction).toBe('top-up-in-wallet');
    expect(journeyFor({ status: 'awaiting_payment', uxStage: 'review' }).nextAction).toBe('approve-in-wallet');
  });
  it('distinguishes expired unpaid quotes, confirmed failure and delivery readiness', () => {
    expect(journeyFor({ expiresAt: '2020-01-01', status: 'awaiting_payment' }).nextAction).toBe('review-expired-quote');
    expect(journeyFor({ status: 'failed', payment: { success: true } }).message).toContain('after payment');
    expect(journeyFor({ status: 'succeeded' }).message).not.toContain('visible');
  });
});
