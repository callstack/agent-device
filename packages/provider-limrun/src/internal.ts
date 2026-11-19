/**
 * The seam core composes Limrun through while the provider is still built in. Nothing here loads the
 * Limrun SDK: the runtime, the platform adapters, and the connection's verification each load when
 * their own path asks for them. The root entry keeps the SDK-side surface.
 */
export { limrunPlugin, type LimrunPluginOptions } from './plugin.ts';
export { LIMRUN_CONNECTION_CAPABILITIES } from './device.ts';
export { readLimrunCredentials } from './credentials.ts';
