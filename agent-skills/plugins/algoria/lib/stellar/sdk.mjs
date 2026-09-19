/**
 * Getting at `@stellar/stellar-sdk`, wherever it happens to live.
 *
 * Two modules need real XDR — `lib/stellar/trustline.mjs` signs a `changeTrust`
 * transaction and `lib/anchor/sep10.mjs` signs the anchor's challenge. Everything
 * else in this package runs on Node alone.
 *
 * A user who installed this plugin from a marketplace never ran `pnpm install`,
 * so the committed bundle at `lib/vendor/stellar-sdk.mjs` is tried first and is
 * what normally answers. The real package is the fallback, so a development
 * checkout that has not been bundled yet still works, and so does a bundle that
 * is deliberately deleted. Only a genuinely missing module falls through; any
 * other failure from the bundle is a real error and is raised as one.
 */

const MODULE_NOT_FOUND = new Set(['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND']);

/** @param {unknown} error */
function isMissingModule(error) {
  return (
    typeof error === 'object' &&
    error !== null &&
    MODULE_NOT_FOUND.has(/** @type {{code?: string}} */ (error).code ?? '')
  );
}

/**
 * The SDK calls `new Buffer()`, which makes Node print a two-line DEP0005
 * warning at the very top of the output. Agent hosts often show only the first
 * few lines of a command, so that warning displaced what the user needed — a
 * top-up's payment link. It is not ours to fix and says nothing actionable, so
 * that one code is dropped; every other warning still goes through.
 */
function silenceBufferDeprecation() {
  const original = process.emitWarning;
  /** @type {(...args: any[]) => void} */
  const filtered = (warning, ...rest) => {
    const [typeOrOptions, code] = rest;
    const warningCode =
      typeof typeOrOptions === 'object' && typeOrOptions !== null ? typeOrOptions.code : code;
    if (warningCode === 'DEP0005') return;
    original.call(process, warning, ...rest);
  };
  process.emitWarning = /** @type {typeof process.emitWarning} */ (filtered);
}

/**
 * @returns {Promise<typeof import('@stellar/stellar-sdk')>}
 */
export async function loadSdk() {
  silenceBufferDeprecation();
  // Resolved through a URL rather than a bare specifier so that the 300KB
  // minified bundle stays out of `tsc`'s graph; it is generated, not authored.
  const bundle = new URL('../vendor/stellar-sdk.mjs', import.meta.url).href;
  try {
    return /** @type {typeof import('@stellar/stellar-sdk')} */ (
      /** @type {unknown} */ (await import(bundle))
    );
  } catch (bundleError) {
    if (!isMissingModule(bundleError)) throw bundleError;
  }

  try {
    return await import('@stellar/stellar-sdk');
  } catch (error) {
    if (!isMissingModule(error)) throw error;
    throw new Error(
      'this command needs the Stellar SDK, and neither the bundled copy at ' +
        'lib/vendor/stellar-sdk.mjs nor an installed @stellar/stellar-sdk was found. ' +
        'In a development checkout, run `pnpm install && pnpm bundle:sdk` in the plugin ' +
        'directory. In an installed plugin, reinstall it — the bundle ships with it.'
    );
  }
}
