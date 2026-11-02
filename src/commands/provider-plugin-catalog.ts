type ProviderPluginDeclaration = Readonly<{
  provider: string;
  package: string;
  label: string;
}>;

const PROVIDER_PLUGIN_CATALOG: readonly ProviderPluginDeclaration[] = [
  { provider: 'revyl', package: '@agent-device/revyl', label: 'Revyl' },
  { provider: 'testmu', package: '@agent-device/testmu', label: 'TestMu AI' },
  { provider: 'webos', package: '@agent-device/webos', label: 'LG webOS' },
];

export function getProviderPluginDeclaration(
  provider: string,
): ProviderPluginDeclaration | undefined {
  return PROVIDER_PLUGIN_CATALOG.find((plugin) => plugin.provider === provider);
}

// One line for the whole catalog keeps help remote's first screen fixed as plugins are added.
export function providerPluginHelp(): string {
  const plugins = PROVIDER_PLUGIN_CATALOG.map(
    (plugin) => `${plugin.label} (connect ${plugin.provider}; ${plugin.package})`,
  ).join(', ');
  return `  Plugins, installed separately: ${plugins}. Run agent-device plugins add <package>, then retry agent-device connect <provider> with your original arguments.`;
}
