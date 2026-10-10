import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const output = new URL('../dist/', import.meta.url);
const routes = ['/', '/how-to-use/'];
const load = (pathname) => readFile(new URL(`${pathname.slice(1)}index.html`, output), 'utf8');

test('every internal navigation link resolves to an exported page and existing anchor', async () => {
  for (const route of routes) {
    const html = await load(route);
    for (const [, href] of html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)) {
      const destination = new URL(href, `https://algoria-x.vercel.app${route}`);
      if (destination.origin !== 'https://algoria-x.vercel.app') continue;
      assert.ok(routes.includes(destination.pathname), `${route}: missing static route ${href}`);
      const target = await load(destination.pathname);
      if (destination.hash) {
        const id = decodeURIComponent(destination.hash.slice(1));
        assert.ok(target.includes(`id="${id}"`), `${route}: missing anchor ${href}`);
      }
    }
  }
});

test('install and example links point at separate, usable setup steps', async () => {
  const home = await load('/');
  const setup = await load('/how-to-use/');
  assert.match(home, /href="\/how-to-use\/#install"[^>]*>Get started</);
  assert.match(home, /href="\/how-to-use\/#use"[^>]*>Example prompts</);
  assert.match(setup, /aria-label="Setup steps"/);
  assert.match(setup, /href="#wallet"/);
  assert.match(setup, /id="wallet"/);
  assert.match(setup, /npx algoria@latest install --agent codex/);
  assert.match(setup, /Copy marketplace command/);
  assert.match(setup, /Copy install command/);
});
