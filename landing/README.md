# Algoria landing page

A public, static, English one-page introduction to Algoria. The visual direction follows the original
pitch: near-black surfaces, large system typography, thin borders, and restrained cyan/violet accents.
There are no accounts, wallet connections, payment actions, tracking scripts, or frontend secrets.

## Local development

Node.js 22 or newer is sufficient; no dependencies need to be installed.

```sh
node serve.mjs
node build.mjs
```

The preview runs at `http://127.0.0.1:4173`. The build copies the three public assets into `dist/`.
Only `dist/` is deployed; development scripts and repository files are not served.

## Content

The page links to the existing Supabase discovery API, service contract, and OpenAPI document, and to
the integration guide on GitHub. The displayed workflow is an explicitly labeled illustration; visiting
the page cannot trigger an image generation or payment. The copy button copies a read-only discovery
request. The skill is labeled as upcoming until a real installation resource is available.

## Hosting

The Sites project identity is recorded in `.openai/hosting.json`. Source credentials are temporary and
must never be written to this directory, Git configuration, or the published bundle.

Supabase remains the API host. Its shared domains return HTML from Storage/Edge Functions as plain
text, so the landing page uses dedicated static hosting. See the official
[Edge Function development tips](https://supabase.com/docs/guides/functions/development-tips) and
[Storage quickstart](https://supabase.com/docs/guides/storage/quickstart).

Future skill downloads can be linked from the existing upcoming section. Keep installation credentials
and local wallet material out of the public site.
