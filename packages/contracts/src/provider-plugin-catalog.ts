import type { ConnectionProviderCapabilities } from './provider-connection.ts';
import type { PluginReleaseDeclaration } from './plugin-installation.ts';

/** What a route must do about a provider whose plugin this host cannot supply. */
export type ProviderAdmissionPolicy = 'provider' | 'route';

export type ProviderPluginDeclaration = PluginReleaseDeclaration &
  Readonly<{
    provider: string;
    label: string;
    /**
     * The plugin's own `connection.capabilities` declaration, readable without loading the plugin. A
     * connection's lease policy comes from its provider on every route, including one whose plugin
     * this host does not load, so the same command behaves the same with or without it installed.
     * `provider-policy.test.ts` keeps this copy equal to the plugin's own declaration.
     */
    connectionCapabilities?: ConnectionProviderCapabilities;
    /**
     * Whether a route that needs this provider admits it itself before it authenticates or writes
     * anything. `'provider'` means only the plugin can supply the provider, because the core ships no
     * runtime for it, so a route driving a connection here refuses a provider it has no plugin for.
     * `'route'`, the default, keeps this release's starting behavior: the `connect` handler admits a
     * named provider, and the adapter that reads a profile verifies the provider it names.
     */
    admission?: ProviderAdmissionPolicy;
  }>;

export const AWS_DEVICE_FARM: ProviderPluginDeclaration = {
  provider: 'aws-device-farm',
  package: '@agent-device/aws-device-farm',
  label: 'AWS Device Farm',
};

export const BROWSERSTACK: ProviderPluginDeclaration = {
  provider: 'browserstack',
  package: '@agent-device/browserstack',
  label: 'BrowserStack',
};

export const LIMRUN: ProviderPluginDeclaration = {
  provider: 'limrun',
  package: '@agent-device/limrun',
  label: 'Limrun',
  admission: 'provider',
  connectionCapabilities: {
    leaseKind: 'direct-device-provider',
    requiresAppAttachment: false,
    requiresRemoteDaemon: false,
    supportsArtifacts: false,
    supportsDeferredAppSelection: true,
    supportsDirectPortReverse: true,
    usesCloudWebDriverLease: false,
    holdsCloudDevice: true,
    forgetsEndedConnectionLease: true,
  },
};

const PROVIDER_PLUGIN_CATALOG: readonly ProviderPluginDeclaration[] = [
  {
    provider: 'adc',
    package: '@agent-device/adc',
    label: 'ADC',
    admission: 'provider',
    connectionCapabilities: {
      leaseKind: 'direct-device-provider',
      requiresAppAttachment: false,
      requiresRemoteDaemon: false,
      supportsArtifacts: false,
      supportsDeferredAppSelection: false,
      supportsDirectPortReverse: false,
      usesCloudWebDriverLease: false,
      holdsCloudDevice: true,
    },
  },
  AWS_DEVICE_FARM,
  BROWSERSTACK,
  LIMRUN,
  { provider: 'revyl', package: '@agent-device/revyl', label: 'Revyl' },
  {
    provider: 'testmu',
    package: '@agent-device/testmu',
    label: 'TestMu AI',
  },
  {
    provider: 'webos',
    package: '@agent-device/webos',
    label: 'LG webOS',
  },
  {
    provider: 'tizen',
    package: '@agent-device/tizen',
    label: 'Samsung Tizen',
  },
];

/** Every catalog row, so the release check can compare each row's package with what it publishes. */
export function providerPluginDeclarations(): readonly ProviderPluginDeclaration[] {
  return PROVIDER_PLUGIN_CATALOG;
}

export function getProviderPluginDeclaration(
  provider: string,
): ProviderPluginDeclaration | undefined {
  return PROVIDER_PLUGIN_CATALOG.find((plugin) => plugin.provider === provider);
}

/**
 * The capabilities a plugin provider declares, read from the catalog without loading the plugin or
 * its store. Undefined for a provider the catalog does not list.
 */
export function providerPluginConnectionCapabilities(
  provider: string | undefined,
): ConnectionProviderCapabilities | undefined {
  return provider === undefined
    ? undefined
    : getProviderPluginDeclaration(provider)?.connectionCapabilities;
}

/** How a route treats a provider it must admit itself; see `ProviderAdmissionPolicy`. */
export function providerPluginAdmission(provider: string | undefined): ProviderAdmissionPolicy {
  return (
    (provider === undefined ? undefined : getProviderPluginDeclaration(provider)?.admission) ??
    'route'
  );
}
