import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const app = resolve(root, '.build/Algoria Signing Proof.app');
await mkdir(resolve(app, 'Contents/MacOS'), { recursive: true });
await mkdir(resolve(app, 'Contents/Resources'), { recursive: true });
await build({
  absWorkingDir: root, entryPoints: ['src/runtime.mjs'], bundle: true,
  format: 'iife', globalName: 'AlgoriaProof', platform: 'browser', target: 'safari18',
  define: { global: 'globalThis' },
  outfile: resolve(app, 'Contents/Resources/transaction.js'), legalComments: 'eof',
});
await writeFile(resolve(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.algoria.tempo-signing-proof</string>
<key>CFBundleName</key><string>Algoria Signing Proof</string>
<key>CFBundleExecutable</key><string>AlgoriaSigningProof</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSMinimumSystemVersion</key><string>15.0</string>
</dict></plist>
`);
execFileSync('swiftc', ['Sources/main.swift', '-o', resolve(app, 'Contents/MacOS/AlgoriaSigningProof'),
  '-framework', 'AppKit', '-framework', 'Security', '-framework', 'LocalAuthentication',
  '-framework', 'JavaScriptCore', '-module-cache-path', resolve(root, '.build/module-cache')],
{ cwd: root, stdio: 'inherit' });
execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
console.log(`Built locally ad-hoc signed proof: ${app}\nNot notarized or production-distributable.`);
