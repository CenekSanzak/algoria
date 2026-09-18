/**
 * The only parts of `@stellar/stellar-sdk` this package uses.
 *
 * `pnpm bundle:sdk` compiles this into `lib/vendor/stellar-sdk.mjs`, which is
 * committed. That bundle is what an installed plugin loads: a user who
 * installed Algoria from a marketplace never ran `pnpm install`, and signing a
 * `changeTrust` transaction or a SEP-10 challenge needs real XDR.
 *
 * Adding a symbol here is the only way to make it reachable at runtime. Bundle
 * again after editing, and commit the result.
 */
export {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  WebAuth
} from '@stellar/stellar-sdk';
