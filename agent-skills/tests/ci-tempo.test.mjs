import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const root = new URL('../../', import.meta.url);
/** @param {string} path */
const read = (path) => readFile(new URL(path, root), 'utf8');

describe('Tempo build dependency contract', () => {
  for (const workflow of ['ci.yml', 'publish-npm.yml']) {
    it(`${workflow} installs the shared builder before checking and bundling`, async () => {
      const workflowSource = await read(`.github/workflows/${workflow}`);
      // Check only the plugin job, not the independent Svelte app jobs.
      const source = workflow === 'ci.yml'
        ? workflowSource.slice(workflowSource.indexOf('\n  agent-skills:'), workflowSource.indexOf('\n  verify:'))
        : workflowSource;
      const typeCheck = source.indexOf('run: pnpm check');
      const preparation = source.slice(0, typeCheck);
      expect(typeCheck).toBeGreaterThan(0);
      expect(preparation).toMatch(/run: pnpm install --frozen-lockfile --ignore-workspace --ignore-scripts/);
      expect(preparation).toMatch(/working-directory: native\/tempo-signing-proof\s+run: npm ci --ignore-scripts --no-audit --no-fund/);
      expect(source).toMatch(/working-directory: native\/tempo-signing-proof\s+run: npm test/);
      expect(source).toMatch(/pnpm bundle:tempo\s+git diff --exit-code -- plugins\/algoria\/lib\/vendor\//);
    });
  }

  it('pins the same Tempo SDK versions in both build packages', async () => {
    const harness = JSON.parse(await read('agent-skills/package.json'));
    const companion = JSON.parse(await read('native/tempo-signing-proof/package.json'));
    const lock = JSON.parse(await read('native/tempo-signing-proof/package-lock.json'));
    for (const sdk of ['mppx', 'ox', 'viem']) {
      expect(harness.dependencies[sdk]).toBe(companion.dependencies[sdk]);
      expect(lock.packages[`node_modules/${sdk}`].version).toBe(companion.dependencies[sdk]);
    }
  });

  it('checks release inputs when shared Tempo source changes', async () => {
    expect(await read('.github/workflows/publish-npm.yml')).toContain("- 'native/tempo-signing-proof/**'");
  });

  it('verifies published CLI stdout separately from npm notices, including on reruns', async () => {
    const source = await read('.github/workflows/publish-npm.yml');
    const smoke = source.slice(source.indexOf('- name: Smoke test the published package'));
    expect(smoke).not.toContain("if: steps.version.outputs.publish");
    expect(smoke).toContain('NPM_CONFIG_CACHE: ${{ runner.temp }}/algoria-published-npm-cache');
    expect(smoke).toContain('npm exec --yes --package="algoria@$VERSION" -- algoria --version 2>npm-install-error.log');
    expect(smoke).not.toContain('2>&1');
    expect(smoke).toContain('seq 1 30');
  });
});
