import { readVersion } from '@agent-device/host-kit/version';
import {
  type PluginReleaseDeclaration,
  pluginInstallCommand,
  pluginPackageSelector,
  pluginRepairCommand,
} from '@agent-device/contracts/plugin-installation';

type ProviderPluginDeclaration = PluginReleaseDeclaration &
  Readonly<{
    provider: string;
    label: string;
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

export const LIMRUN: ProviderPluginDeclaration = {
  provider: 'limrun',
  package: '@agent-device/limrun',
  label: 'Limrun',
  nightlyTag: 'nightly-0.22',
};

const PROVIDER_PLUGIN_CATALOG: readonly ProviderPluginDeclaration[] = [
  AWS_DEVICE_FARM,
  BROWSERSTACK,
  LIMRUN,
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

export function providerPluginInstallCommand(
  declaration: ProviderPluginDeclaration,
  coreVersion: string = readVersion(),
): string {
  return pluginInstallCommand(declaration, coreVersion);
}

export function providerPluginRepairCommand(
  declaration: ProviderPluginDeclaration,
  coreVersion: string = readVersion(),
): string {
  return pluginRepairCommand(declaration, coreVersion);
}

export function providerPluginHelp(coreVersion: string = readVersion()): string {
  const plugins = PROVIDER_PLUGIN_CATALOG.map(
    (plugin) =>
      `${plugin.label} (connect ${plugin.provider}; ${pluginPackageSelector(plugin, coreVersion)})`,
  ).join(', ');
  return `  Plugins, installed separately: ${plugins}. Run agent-device plugins add <package>, then retry agent-device connect <provider> with your original arguments.`;
}
