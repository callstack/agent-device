import { readVersion } from '@agent-device/host-kit/version';
import {
  pluginInstallCommand,
  pluginPackageSelector,
  pluginRepairCommand,
} from '@agent-device/contracts/plugin-installation';

import {
  providerPluginDeclarations,
  type ProviderPluginDeclaration,
} from '@agent-device/contracts/provider-plugin-catalog';

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
  const plugins = providerPluginDeclarations()
    .map(
      (plugin) =>
        `${plugin.label} (connect ${plugin.provider}; ${pluginPackageSelector(plugin, coreVersion)})`,
    )
    .join(', ');
  return `  Plugins, installed separately: ${plugins}. Run agent-device plugins add <package>, then retry agent-device connect <provider> with your original arguments.`;
}
