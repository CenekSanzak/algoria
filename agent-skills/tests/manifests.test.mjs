/**
 * The plugin's identity lives in three files, because three consumers need it:
 * Claude's manifest, Codex's manifest, and npm's `package.json`. Nothing makes
 * them agree, so this does.
 *
 * A mismatch is not cosmetic. The two plugin catalogues and the npm registry
 * would each claim a different version of the same thing, and a user could not
 * tell which one they have.
 */

import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

const PLUGIN = new URL('../plugins/algoria/', import.meta.url);

/** @param {string} path @returns {Promise<any>} */
const load = async (path) => JSON.parse(await readFile(new URL(path, PLUGIN), 'utf8'));

const claude = await load('.claude-plugin/plugin.json');
const codex = await load('.codex-plugin/plugin.json');
const npm = await load('package.json');

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

describe('plugin manifests', () => {
  it('agree on the version', () => {
    expect(codex.version).toBe(claude.version);
    expect(npm.version).toBe(claude.version);
  });

  it('use strict semver, which Codex requires', () => {
    expect(claude.version).toMatch(SEMVER);
  });

  it('agree on the plugin name', () => {
    expect(codex.name).toBe(claude.name);
  });

  it('declare no runtime dependencies on npm', () => {
    // The Stellar SDK is bundled into lib/vendor/ precisely so that an installed
    // plugin needs no `npm install`. A dependency here silently undoes that and
    // makes `npx algoria` pay a download it does not need.
    expect(npm.dependencies).toBeUndefined();
  });

  it('carries the interface block Codex validates', () => {
    for (const field of [
      'displayName',
      'shortDescription',
      'longDescription',
      'developerName',
      'category'
    ]) {
      expect(codex.interface?.[field], field).toBeTruthy();
    }
    expect(Array.isArray(codex.interface?.capabilities)).toBe(true);
    expect(codex.interface?.defaultPrompt?.length).toBeGreaterThan(0);
    // Codex silently drops entries past the third.
    expect(codex.interface.defaultPrompt.length).toBeLessThanOrEqual(3);
  });

  it('ships every file the npm package promises', async () => {
    for (const entry of npm.files) {
      await expect(
        readFile(new URL(entry.replace(/\/$/, ''), PLUGIN)).catch((error) =>
          error.code === 'EISDIR' ? 'directory' : Promise.reject(error)
        ),
        entry
      ).resolves.toBeTruthy();
    }
  });

  it('points `bin` at a real executable', async () => {
    const bin = npm.bin.algoria;
    const source = await readFile(new URL(bin, PLUGIN), 'utf8');
    expect(source.startsWith('#!/usr/bin/env node')).toBe(true);
  });
});
