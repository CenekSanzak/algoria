import { describe, expect, it, vi, afterEach } from 'vitest';
import { deliveryFor } from '../plugins/algoria/lib/services/delivery.mjs';
import { apiFetch, API_BASE } from '../plugins/algoria/lib/services/api.mjs';
afterEach(() => vi.unstubAllGlobals());
describe('media presentation', () => {
  it('identifies signed media with refresh hints without claiming it rendered', () => {
    const url = 'https://media.example/image.png?token=output-access';
    expect(deliveryFor({ id: 'job', status: 'succeeded', output: { images: [{ url, content_type: 'image/png' }], url_expires_in: 3600 } })).toMatchObject({ jobId: 'job', previewRequired: true, refreshable: true, expiresInSeconds: 3600, media: [{ url, contentType: 'image/png' }] });
  });
  it('does not expose failed or uncertain output as a deliverable', () => {
    const output = { images: [{ url: 'https://example.com/image', content_type: 'image/png' }] };
    expect(deliveryFor({ status: 'failed', output })).toBeNull();
    expect(deliveryFor({ status: 'succeeded', phase: 'uncertain', output })).toBeNull();
  });
  it('does not claim external URLs can be refreshed or never expire', () => {
    expect(deliveryFor({ source: 'stellar8004', status: 'succeeded', output: { video: { url: 'https://example.com/video', content_type: 'video/mp4' } } })).toMatchObject({ refreshable: false, urlsExpire: null });
  });
  it('does not offer arbitrary output links as media or allow non-HTTPS URLs', () => {
    expect(deliveryFor({ status: 'succeeded', output: { url: 'https://example.com/page' } })).toBeNull();
    expect(deliveryFor({ status: 'succeeded', output: { images: [{ url: 'javascript:alert(1)', content_type: 'image/png' }, { url: 'https://user:pass@example.com/image', content_type: 'image/png' }] } })).toBeNull();
  });
  it('distinguishes catalog connectivity failure from uncertain payment', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(apiFetch(`${API_BASE}/discovery/resources`)).rejects.toThrow('No payment was attempted');
    await expect(apiFetch(`${API_BASE}/v1/services/image.generate`, { method: 'POST' })).rejects.toThrow('recover the saved job');
  });
});
