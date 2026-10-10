import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const page = (path) => readFile(new URL(`dist/${path}`, root), 'utf8');

test('built pages describe Tempo testnet without legacy funding instructions', async () => {
  for (const path of ['index.html', 'how-to-use/index.html']) {
    const html = await page(path);
    assert.match(html, /Tempo/);
    assert.match(html, /testnet/);
    assert.match(html, /test PathUSD/);
    assert.match(html, /Touch ID/);
    assert.doesNotMatch(html, /Stellar|Turkish lira|\bIBAN\b|200 TRY|wallet onboard|topup start/);
    assert.doesNotMatch(html, /algoria-services\.robust-lime-0047\.chatgpt\.site/);
  }
});

test('home metadata and MPP positioning match the Vercel site', async () => {
  const html = await page('index.html');
  assert.match(html, /rel="canonical" href="https:\/\/algoria-x\.vercel\.app\/"/);
  assert.match(html, /property="og:url" content="https:\/\/algoria-x\.vercel\.app\/"/);
  assert.match(html, /property="og:image" content="https:\/\/algoria-x\.vercel\.app\/algoria-tempo-preview\.jpg"/);
  assert.doesNotMatch(html, /algoria-thumbnail\.png/);
  assert.match(html, /MPP payments on Tempo testnet/);
  assert.match(html, /local wallet build required/);
  assert.match(html, /Mocked demo/);
});

test('Tempo share preview is a locally bundled JPEG', async () => {
  const bytes = await readFile(new URL('static/algoria-tempo-preview.jpg', root));
  assert.equal(bytes.subarray(0, 3).toString('hex'), 'ffd8ff');
  assert.ok(bytes.length > 10000);
});

test('setup discloses native build and local-only spending permissions', async () => {
  const html = await page('how-to-use/index.html');
  assert.match(html, /ALGORIA_TEMPO_SIGNER_APP/);
  assert.match(html, /pay readiness --json/);
  assert.match(html, /npm ci --ignore-scripts/);
  assert.match(html, /macOS 15\+/);
  assert.match(html, /disposable/);
  assert.match(html, /not a packaged or notarized installer/);
  assert.match(html, /not autonomous signing or full ERC-8196 compliance/);
  assert.match(html, /Every new payment still needs Touch ID/);
});
