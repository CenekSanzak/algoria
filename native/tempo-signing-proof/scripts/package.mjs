import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const app = fileURLToPath(new URL('../.build/Algoria Signing Proof.app', import.meta.url));
const archive = fileURLToPath(new URL('../.build/Algoria-Tempo-Companion-0.11.0.zip', import.meta.url));
execFileSync('codesign', ['--verify', '--deep', '--strict', app]);
execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive]);
console.log(JSON.stringify({ archive, sha256: createHash('sha256').update(await readFile(archive)).digest('hex'),
  signing: 'ad-hoc-development', notarized: false, productionDistributionReady: false }, null, 2));
