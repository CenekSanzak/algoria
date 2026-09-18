import { defineConfig } from 'vitest/config';

/**
 * This package is deliberately independent of the app at the repository root.
 * Declaring the config here stops Vitest walking up and loading the SvelteKit
 * `vite.config.ts`, whose plugins are not installed in this directory, and the
 * empty `tsconfigRaw` stops esbuild reaching for the root tsconfig too.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.mjs'],
    environment: 'node'
  },
  esbuild: {
    tsconfigRaw: '{}'
  }
});
