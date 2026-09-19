import process from 'node:process';
import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // On Vercel, adapter-static runs in zero-config mode (writes .vercel/output), which
    // it only does when given no options. Elsewhere, hosting serves dist/ (see .openai/hosting.json).
    adapter: adapter(process.env.VERCEL ? undefined : { pages: 'dist', assets: 'dist', strict: true })
  }
};

export default config;
