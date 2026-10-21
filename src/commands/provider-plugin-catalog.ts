type ProviderPluginDeclaration = Readonly<{
  provider: string;
  package: string;
  label: string;
}>;

const PROVIDER_PLUGIN_CATALOG: readonly ProviderPluginDeclaration[] = [
  { provider: 'testmu', package: '@agent-device/testmu', label: 'TestMu AI' },
];

export function getProviderPluginDeclaration(
  provider: string,
): ProviderPluginDeclaration | undefined {
  return PROVIDER_PLUGIN_CATALOG.find((plugin) => plugin.provider === provider);
}

export function providerPluginHelp(): string {
  return PROVIDER_PLUGIN_CATALOG.map(
    (plugin) =>
      `  ${plugin.label} (plugin, install separately): agent-device plugins add ${plugin.package}; then retry agent-device connect ${plugin.provider} with your original arguments.`,
  ).join('\n');
}
