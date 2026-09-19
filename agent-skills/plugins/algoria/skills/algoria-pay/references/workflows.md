# Composing paid services

A request like "bana ürünüm için seslendirmeli bir reklam videosu üret" is one
user task. You perform the required service calls; the user need not supply
pre-generated assets or run each stage. For a vague "make me a video", clarify
its subject if absent. Choose reasonable scene/pacing defaults when they do
not change the user's intent.

Discover each service's current schema and price. Do not assume all services
accept the same body or charge the same recipient.

The current product-ad flow is image.generate for each scene, speech.generate
for narration, video.slideshow for ordered scenes, video.compose to combine the
slideshow and narration, then video.caption. Use separate saved job IDs under
one approved named budget, and record which outputs feed the next step.

Before spending, read the needed service contracts and calculate the whole
plan's price, including upstream generations. Keep a local workflow note with
the brief, approved budget name, planned steps, their saved job IDs and their
dependencies. Store it under `~/.algoria/workflows/` (or `ALGORIA_HOME`) rather
than a project repository. It needs no seeds, tokens or signed headers. Record
each ID as soon as quote returns it, so a later session can resume the same work.

For a product-ad example, generate the scene images and a short narration,
check the narration's actual duration, then choose slideshow scene durations
that cover it. Quote the slideshow with those generated image URLs, compose
its completed output with the narration, and caption the completed composition
if requested. The current video pipeline produces a slideshow/montage with
optional narration/captions; do not present it as arbitrary text-to-video motion
generation. Use another capability only if discovery actually exposes it.

Do not invoke unnecessary paid stages: narration or captions belong in the plan
only when requested or agreed as part of the proposed result. Return the final
media in the conversation, with total charged test USDC, rather than a list of
commands or internal job IDs. Intermediate outputs are useful when the user
asks for them or a later stage fails; they do not replace an agreed final video.

Before a new downstream quote, refresh the completed upstream jobs with status.
Use the resulting signed Algoria media URLs; video services do not accept
arbitrary external uploads. Check the returned dimensions and actual duration
against the downstream schema. The slideshow must cover the narration, and
current composition/caption inputs are limited to 30 seconds.

Once a downstream job is saved, do not replace its input URLs on retry even if
they have expired: its exact original input remains the identity of that job.
The server handles accepted-job source refresh. New input needs a new quote
and its own budget reservation.

The helper stores tokens and signed authorizations with mode 0600 under
ALGORIA_HOME (normally ~/.algoria). Do not paste that state into the conversation.
Use pay list/status, which project only public job/result/receipt fields.
