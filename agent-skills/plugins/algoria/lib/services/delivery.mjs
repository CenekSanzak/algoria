/** Public media hints, never a claim that a host actually rendered the result.
 * No downloads, network calls or credentials are involved here.
 * @param {any} job
 */
export function deliveryFor(job) {
  if (job.status !== 'succeeded' || job.phase === 'uncertain') return null;
  const output = job.output;
  const candidates = [
    ...(Array.isArray(output?.images) ? output.images : []),
    output?.audio, output?.video
  ];
  const media = candidates.flatMap((item) => {
    if (typeof item?.url !== 'string' || typeof item?.content_type !== 'string' ||
        !/^(image|audio|video)\/[a-z0-9.+-]+$/i.test(item.content_type)) return [];
    try {
      const url = new URL(item.url);
      if (url.protocol !== 'https:' || url.username || url.password) return [];
      return [{ url: item.url, contentType: item.content_type }];
    } catch { return []; }
  });
  if (!media.length) return null;
  return {
    jobId: job.id, media, previewRequired: true,
    urlsExpire: job.source !== 'stellar8004' || Number.isFinite(output?.url_expires_in) ? true : null,
    expiresInSeconds: Number.isFinite(output?.url_expires_in) ? output.url_expires_in : null,
    refreshable: job.source !== 'stellar8004',
    instruction: 'Present the media with the host native preview/browser tools and verify it loaded before saying it is visible. A raw URL or unverified Markdown embed is not delivery. Refresh Algoria URLs with status on this same job; never pay again to fix display. Do not download to bypass host display restrictions.'
  };
}
