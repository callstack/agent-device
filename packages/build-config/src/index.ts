import { readFileSync } from 'node:fs';
import type { InputOptions } from 'rolldown';

export const strictBundlerInputOptions: InputOptions = {
  onLog(level, log, handler) {
    if (log.code === 'UNRESOLVED_IMPORT') throw new Error(log.message);
    handler(level, log);
  },
};

export const providerPluginBuildConfig = {
  entry: { 'agent-device': 'src/index.ts' },
  outDir: 'dist',
  format: 'esm' as const,
  platform: 'node' as const,
  target: 'es2022' as const,
  minify: true,
  dts: false,
  hash: false,
  deps: { alwaysBundle: [/^@agent-device\//] },
  inputOptions: strictBundlerInputOptions,
};

/**
 * The bundler options every managed platform plugin package builds with: its own `agent-device`
 * entry, emitted types, and `agent-device/plugins` kept external because the running core owns
 * that contract. Each package's `build.mjs` spreads this and calls `build`.
 */
export const managedPlatformPluginBuildConfig = {
  ...providerPluginBuildConfig,
  config: false,
  dts: true,
  tsconfig: '../../tsconfig.lib.json',
  deps: {
    ...providerPluginBuildConfig.deps,
    neverBundle: ['agent-device/plugins'],
  },
};

/**
 * Checks a managed platform plugin's default-exported factory against the `agent-device` claim in
 * its own package.json — the same pair the loader reads at install time, so a package that
 * contributes another family, or a stale contract version, fails its build rather than its users.
 * The caller passes its `package.json` URL and the factory it imported.
 */
export function assertManagedPlatformPluginFactory(
  packageJsonUrl: URL,
  factory: () => {
    apiVersion: unknown;
    contributes: readonly { kind: unknown; family: unknown }[];
  },
  label: string,
): void {
  const manifest = JSON.parse(readFileSync(packageJsonUrl, 'utf8'))['agent-device'] as {
    apiVersion: unknown;
    platform: unknown;
  };
  const { apiVersion, contributes } = factory();
  const [platform] = contributes;
  if (
    apiVersion !== manifest.apiVersion ||
    contributes.length !== 1 ||
    platform?.kind !== 'platform' ||
    platform.family !== manifest.platform
  ) {
    throw new Error(`The managed ${label} factory must match its package claim`);
  }
}
