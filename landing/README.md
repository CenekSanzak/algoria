# Algoria landing page

The public site for the Algoria plugin: buy AI services without leaving Claude or Codex. It is a
standalone SvelteKit app, separate from the chat app at the repository root, and is prerendered to static
HTML with `@sveltejs/adapter-static`. There are no accounts, wallet connections, payment actions,
tracking scripts, or frontend secrets.

The design follows [algoria.chat](https://algoria.chat): its slate tokens, Prompt and Geist Mono, glass
cards, dark by default with a light toggle. `static/favicon.svg` and `static/algoria-thumbnail.png` are
copied from there.

## Local development

Node.js 22 or newer and pnpm.

```sh
pnpm install
pnpm dev       # http://127.0.0.1:4173
pnpm check     # svelte-check
pnpm build     # prerenders to dist/
pnpm preview   # serves the built dist/
```

Only `dist/` is deployed (or `.vercel/output/` on Vercel, see below).

## Layout

```
src/app.html                     shell; applies the saved theme before first paint
src/app.css                      design tokens, base styles, shared .wrap/.card/.eyebrow
src/routes/+layout.svelte        header, main, footer
src/routes/+page.svelte          hero (mocked demo) and how-it-works; page <head> and Open Graph tags
src/routes/how-to-use/          install card and example prompts
src/lib/links.ts                 external links and site metadata
src/lib/components/
  HeroDemo.svelte                scripted, mocked Claude Code / Codex session for the hero
  InstallCard.svelte             Claude Code / Codex / npx tabs, defined as data
  CodeBlock.svelte               a command or prompt with its copy button
  ThemeToggle.svelte  SiteHeader.svelte  SiteFooter.svelte  StellarMark.svelte
static/                          favicon and Open Graph image
```

The install commands in `InstallCard.svelte` mirror `agent-skills/README.md`; update both together when
the marketplace name (`algoria-skills`) or CLI commands change. The npx tab shows `! npx algoria …`
lines, which run as shell commands when pasted into Claude Code or Codex.

## Hosting

### Vercel

Import the repository in Vercel and set **Root Directory** to `landing`. The framework preset
(SvelteKit), install command (pnpm, from `pnpm-lock.yaml`) and build command (`pnpm build`) are
detected; leave the output directory empty. Node.js 22 comes from `engines` in `package.json`.

On Vercel `svelte.config.js` passes no options to `adapter-static`, which switches it to zero-config
mode: it writes `.vercel/output/` with clean URLs (`/how-to-use`) and immutable caching for `_app/`.
No environment variables are needed. Once the domain is known, update `site.url` in
`src/lib/links.ts` so canonical and Open Graph URLs point at it.

### Sites

The Sites project identity is recorded in `.openai/hosting.json`, which serves `dist/`. Source
credentials are temporary and must never be written to this directory, Git configuration, or the
published bundle.

Supabase remains the API host. Its shared domains return HTML from Storage/Edge Functions as plain
text, so the landing page uses dedicated static hosting. See the official
[Edge Function development tips](https://supabase.com/docs/guides/functions/development-tips) and
[Storage quickstart](https://supabase.com/docs/guides/storage/quickstart).

The canonical and Open Graph URLs live in `src/lib/links.ts`; change them there if the site moves.
Keep installation credentials and local wallet material out of the public site.
