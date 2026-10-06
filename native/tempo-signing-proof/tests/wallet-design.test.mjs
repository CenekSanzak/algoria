import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('wallet bundles the exact licensed Algoria font assets', async () => {
  const fonts = {
    'Prompt-Regular.ttf': 'dbd497803cec3caffbc6b7f599ca6fed8beea0ed7e0ad1e098130c5ebbc4fd42',
    'Prompt-Medium.ttf': '6a42451be692eba473c639f4bcdc6c6d9160a3d632319a64287e3ed1fae15d6b',
    'Prompt-SemiBold.ttf': '3285c9e6a4ebc480a6476a1a26b44d6eb0f9874025fa96e42afd52172b7f02b9',
    'GeistMono.ttf': 'd00e590b8eb3a59acc329b2d044fd143ae935090b7da33199ebee27cc7de8196',
  };
  for (const [name, hash] of Object.entries(fonts)) {
    const data = await readFile(new URL(`Resources/Fonts/${name}`, root));
    assert.equal(createHash('sha256').update(data).digest('hex'), hash, name);
  }
  for (const name of ['Prompt', 'GeistMono']) {
    assert.match(await read(`Resources/Fonts/${name}-OFL.txt`), /SIL OPEN FONT LICENSE Version 1.1/);
  }
});

test('wallet brand colors follow the existing landing design in both themes', async () => {
  const css = await read('../../landing/src/app.css');
  const [dark, light] = css.split(":root[data-theme='light']");
  const swift = await read('Sources/WalletDesign.swift');
  for (const [name, token] of [['background', 'bg'], ['surface', 'raised'], ['elevated', 'elevated'],
    ['text', 'txt'], ['secondary', 'txt-sec'], ['accent', 'accent']]) {
    const d = dark.match(new RegExp(`--${token}: #([a-f0-9]{6});`))?.[1];
    const l = light.match(new RegExp(`--${token}: #([a-f0-9]{6});`))?.[1];
    assert.ok(d && l, token);
    assert.match(swift, new RegExp(`static let ${name} = adaptive\\([^\\n]*dark: "${d}", light: "${l}"\\)`));
  }
});

test('native build ships offline fonts, licenses and the existing logo', async () => {
  const build = await read('scripts/build.mjs');
  assert.match(build, /cp\(resolve\(root, 'Resources\/Fonts'\)/);
  assert.match(build, /static\/favicon\.svg/);
  assert.match(build, /Sources\/WalletDesign\.swift/);
  assert.doesNotMatch(build, /fetch\(|https:\/\/fonts/);
  const swift = await read('Sources/WalletDesign.swift');
  assert.match(swift, /CTFontManagerRegisterFontsForURL\(url as CFURL, \.process/);
  const logo = await read('../../static/favicon.svg');
  assert.match(logo, /fill="#f2f4f8"/);
  assert.match(logo, /fill="#090c12"/);
});
