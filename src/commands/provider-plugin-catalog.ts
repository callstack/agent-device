import { readVersion } from '@agent-device/host-kit/version';

type ProviderPluginDeclaration = Readonly<{
  provider: string;
  package: string;
  label: string;
  nightlyTag?: 'nightly-0.22';
}>;

export const AWS_DEVICE_FARM: ProviderPluginDeclaration = {
  provider: 'aws-device-farm',
  package: '@agent-device/aws-device-farm',
  label: 'AWS Device Farm',
  nightlyTag: 'nightly-0.22',
};

export const BROWSERSTACK: ProviderPluginDeclaration = {
  provider: 'browserstack',
  package: '@agent-device/browserstack',
  label: 'BrowserStack',
  nightlyTag: 'nightly-0.22',
};

const PROVIDER_PLUGIN_CATALOG: readonly ProviderPluginDeclaration[] = [
  AWS_DEVICE_FARM,
  BROWSERSTACK,
  { provider: 'revyl', package: '@agent-device/revyl', label: 'Revyl' },
  { provider: 'testmu', package: '@agent-device/testmu', label: 'TestMu AI' },
  { provider: 'webos', package: '@agent-device/webos', label: 'LG webOS' },
  { provider: 'tizen', package: '@agent-device/tizen', label: 'Samsung Tizen' },
];

export function getProviderPluginDeclaration(
  provider: string,
): ProviderPluginDeclaration | undefined {
  return PROVIDER_PLUGIN_CATALOG.find((plugin) => plugin.provider === provider);
}

// The release workflow stamps the core and its public plugins with the same nightly version.
const NIGHTLY_0_22_VERSION = /^0\.22\.\d+-nightly(?:-0-22)?\.\d{8}\.[1-9]\d*$/;
const DEVELOPMENT_0_22_VERSION = /^0\.22\.\d+-dev$/;

function providerPluginSelector(
  declaration: ProviderPluginDeclaration,
  coreVersion: string,
): string {
  if (declaration.nightlyTag === undefined) return declaration.package;
  const version = coreVersion.trim();
  if (NIGHTLY_0_22_VERSION.test(version)) return `${declaration.package}@${version}`;
  if (DEVELOPMENT_0_22_VERSION.test(version)) {
    return `${declaration.package}@${declaration.nightlyTag}`;
  }
  return declaration.package;
}

export function providerPluginInstallCommand(
  declaration: ProviderPluginDeclaration,
  coreVersion: string = readVersion(),
): string {
  return `agent-device plugins add ${providerPluginSelector(declaration, coreVersion)}`;
}

export function providerPluginRepairCommand(
  declaration: ProviderPluginDeclaration,
  coreVersion: string = readVersion(),
): string {
  const selector = providerPluginSelector(declaration, coreVersion);
  const action = selector === declaration.package ? 'update' : 'add';
  return `agent-device plugins ${action} ${selector}`;
}

export function providerPluginHelp(coreVersion: string = readVersion()): string {
  const plugins = PROVIDER_PLUGIN_CATALOG.map(
    (plugin) =>
      `${plugin.label} (connect ${plugin.provider}; ${providerPluginSelector(plugin, coreVersion)})`,
  ).join(', ');
  return `  Plugins, installed separately: ${plugins}. Run agent-device plugins add <package>, then retry agent-device connect <provider> with your original arguments.`;
}
