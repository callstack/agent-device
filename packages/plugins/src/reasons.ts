import type { ReasonTable } from '@agent-device/kernel/errors';

/**
 * Why a provider plugin was refused: discovery, validation, the store, and the registry all
 * answer from this one table.
 */
export const PLUGIN_REASONS = {
  // Two plugins claim one provider id, or a plugin claims an id that routing or a built-in provider owns.
  duplicateProvider: { reason: 'duplicate_provider' },
  // The package exports no plugin entry or declares no provider contract this build can load.
  incompatiblePlugin: { reason: 'incompatible_plugin' },
  // The plugin's metadata or code could not be read, resolved, or loaded.
  loadFailed: { reason: 'plugin_load_failed' },
  // The plugin's `setup(host)` threw, or registering what it returned failed.
  setupFailed: { reason: 'plugin_setup_failed' },
  // A plugin claims a provider id reserved for daemon routing, `cloud` or `proxy`.
  reservedProvider: { reason: 'reserved_provider' },
  // The plugin package or what its code returns breaks the plugin contract: an invalid package entry,
  // package version, provider id, credentials or connection, no default factory or `setup(host)`,
  // or a runtime or WebDriver descriptor that lacks a required field.
  invalidPlugin: { reason: 'invalid_plugin' },
} as const satisfies ReasonTable<'plugins'>;

/** One {@link PLUGIN_REASONS} spelling a plugin refusal may carry. */
export type PluginFailureReason = (typeof PLUGIN_REASONS)[keyof typeof PLUGIN_REASONS]['reason'];
