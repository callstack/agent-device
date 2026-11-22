/**
 * The host-facing half of the plugin, for this repository's own suites: they drive the adapters the
 * plugin builds from a `setup` host, and the iOS runner, over the root's real host capabilities
 * without installing the plugin. The published package exports only the plugin factory.
 */
export { createLimrunRuntimeDependencies } from './host-dependencies.ts';
export { createLimrunIosRunner } from './ios-runner.ts';
export { createLimrunAppleToolProvider } from './ios-tools.ts';
export { createLimrunAppleApplicationTools } from './ios-application-tools.ts';
export type { LimrunIosHost } from './ios-host.ts';
