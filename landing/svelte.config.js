import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // Hosting serves dist/ (see .openai/hosting.json), so the prerendered site goes there.
    adapter: adapter({ pages: 'dist', assets: 'dist', strict: true })
  }
};

export default config;
