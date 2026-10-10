import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const output = new URL('../.vercel/output/', import.meta.url);

test('Vercel serves both pages and redirects setup to its canonical directory URL', async () => {
  const config = JSON.parse(await readFile(new URL('config.json', output), 'utf8'));
  assert.equal(config.version, 3);
  assert.equal(config.overrides['index.html'].path, '');
  assert.equal(config.overrides['how-to-use/index.html'].path, 'how-to-use');
  assert.ok(config.routes.some((route) => route.src === '/how-to-use' && route.status === 308 && route.headers?.Location === '/how-to-use/'));
  assert.ok(config.routes.some((route) => route.src === '/how-to-use/' && route.dest === '/how-to-use'));
  for (const file of ['index.html', 'how-to-use/index.html']) {
    const html = await readFile(new URL(`static/${file}`, output), 'utf8');
    assert.match(html, /href="\/how-to-use\/#install"/);
  }
});
