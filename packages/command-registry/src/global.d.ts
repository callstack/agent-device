/**
 * Build-time flag: owner-file claims are enabled outside production bundles.
 * The identifier is undefined in dev/tests and `false` in production builds,
 * so the source defaults it on with `typeof __OWNER_FILES__ === 'undefined'`.
 */
declare const __OWNER_FILES__: boolean;
