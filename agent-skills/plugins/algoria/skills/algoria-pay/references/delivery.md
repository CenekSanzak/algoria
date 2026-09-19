# Deliver media, not an expiring URL

Generation and display are separate steps. `succeeded` proves generation;
it does not prove that the host can embed the returned media. `delivery.media`
in run/status results identifies known image/audio/video outputs and their
display hints. Other outputs still need interpretation of the service schema.

1. Wait for the original `run` command to finish before calling status. If the
   host tool yielded a running process/session, wait on that process; starting
   another run/status concurrently only collides with the job lock.
2. For a completed Algoria job, use its fresh output. When revisiting it later,
   call `status SAME_JOB_ID --json` for fresh signed URLs. Keep the job ID in
   context/memory, not a signed URL. Algoria currently reports URL lifetime in
   `url_expires_in`; these links are not permanent artifacts.
3. Use the host's native media preview. In Codex, for remote media that does
   not have native attachment output, open the exact returned URL in the
   supported in-app browser/preview tools and inspect that it loaded. For an
   image, if the browser tool supports emitting the loaded image or a screenshot
   into the conversation, do so; do not rely solely on Markdown with a signed
   remote URL. Read the tool's current API rather than guessing browser methods.
4. Only state that the image is visible after the preview actually loaded.
   If preview fails, refresh that same Algoria job once and retry presentation.
   Distinguish generation failure, expired link and host display failure. A
   fresh URL can still fail inline because of host display restrictions.
5. Keep the final response in the user's language: show the media and charge.
   Do not print a long signed URL or append another download link when the media
   is already visible. If the host has no working preview, state that limitation
   and provide a descriptive clickable link as the fallback; do not claim that
   an unverified Markdown image is visible.

Respect host URL/display policy. Never download remote media merely to bypass
display restrictions. If the user explicitly wants an exported artifact and
the host permits export, retain the file as an actual deliverable and use its
absolute path; that is separate from this preview fallback.

Display recovery never needs a new quote, generation or payment. Do not make
private output storage public just to force inline rendering. Stellar8004
responses are local-only and cannot inherit Algoria's URL-refresh behavior.
