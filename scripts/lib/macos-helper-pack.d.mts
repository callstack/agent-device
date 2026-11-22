// Type surface for the plain-Node helper pack rules: the package smoke imports the module with bare
// `node`, so it is not in the typechecked program. Keep this file in step with the exports there.
/** Where the helper sits in the packed `@agent-device/macos` tree. */
export const MACOS_HELPER_PACK_ROOT: 'macos-helper';

/** The test targets the helper manifest declares. */
export function readMacosHelperTestTargets(manifestSource: string): string[];

/** The helper's pack stubs: the only paths under its `Tests/` directory the package may carry. */
export const DOCUMENTED_PACK_STUBS: readonly string[];

/** Every way the packed helper tree is not the buildable package it must be, one line each. */
export function macosHelperPackFailures(paths: readonly string[], manifestSource: string): string[];
