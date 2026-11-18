import { readVersion } from '@agent-device/host-kit/version';

/**
 * The npm dist-tag a plugin ships on when it is not on every release. `nightly-0.22` plugins joined
 * the workspace with the 0.22 releases, so their `latest` tag is still the staged placeholder that
 * exports no plugin factory.
 */
type ProviderPluginChannel = 'nightly-0.22';

type ProviderPluginDeclaration = Readonly<{
  provider: string;
  package: string;
  label: string;
  channel?: ProviderPluginChannel;
}>;

const AWS_DEVICE_FARM: ProviderPluginDeclaration = {
  provider: 'aws-device-farm',
  package: '@agent-device/aws-device-farm',
  label: 'AWS Device Farm',
  channel: 'nightly-0.22',
};

const BROWSERSTACK: ProviderPluginDeclaration = {
  provider: 'browserstack',
  package: '@agent-device/browserstack',
  label: 'BrowserStack',
  channel: 'nightly-0.22',
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

// `scripts/release-version.mjs` owns this grammar: the 0.22 source branch publishes a nightly as
// `X.Y.Z-nightly-0-22.<YYYYMMDD>.<run>` and stamps every public workspace package at that version.
const NIGHTLY_0_22_VERSION = /-nightly-0-22\.\d{8}\.[1-9]\d*$/;

/**
 * Whether `coreVersion` is a 0.22 nightly — the only release that pairs core with a channel plugin's
 * matching build. A source checkout (`X.Y.Z-dev`), a nightly of the current release line, and a
 * stable release each take the plain package name, which is what its `latest` tag installs.
 */
function isNightly022Release(coreVersion: string): boolean {
  return NIGHTLY_0_22_VERSION.test(coreVersion.trim());
}

/**
 * The plugin release that pairs with a running core, or `undefined` for the plain package name. One
 * release publishes core and its channel plugins together at one version, so on that channel the
 * matching release is core's own version, and the plain name would install the placeholder.
 */
function channelRelease(
  declaration: ProviderPluginDeclaration,
  coreVersion: string,
): string | undefined {
  if (declaration.channel !== 'nightly-0.22') return undefined;
  return isNightly022Release(coreVersion) ? coreVersion.trim() : undefined;
}

/**
 * The installation command a missing plugin names. On the 0.22 nightly channel it pins the release
 * built with this core, so recovery cannot install the placeholder under `latest`.
 */
export function providerPluginInstallCommand(
  declaration: ProviderPluginDeclaration,
  coreVersion: string = readVersion(),
): string {
  const release = channelRelease(declaration, coreVersion);
  const selector =
    release === undefined ? declaration.package : `${declaration.package}@${release}`;
  return `agent-device plugins add ${selector}`;
}

/**
 * The selector documented for a plugin: its channel tag when it ships on one, and the plain name
 * otherwise. Unlike {@link providerPluginInstallCommand} it names a channel rather than a build, so
 * printed guidance holds across every release of one channel.
 */
function providerPluginSelector(declaration: ProviderPluginDeclaration): string {
  return declaration.channel === undefined
    ? declaration.package
    : `${declaration.package}@${declaration.channel}`;
}

/** The install step the AWS Device Farm and BrowserStack help flows print. */
export const AWS_DEVICE_FARM_PLUGIN_INSTALL = `agent-device plugins add ${providerPluginSelector(AWS_DEVICE_FARM)}`;

export const BROWSERSTACK_PLUGIN_INSTALL = `agent-device plugins add ${providerPluginSelector(BROWSERSTACK)}`;

// One line for the whole catalog keeps help remote's first screen fixed as plugins are added. A
// channel plugin names its tag there, because that tag is what installs while `latest` is a
// placeholder.
export function providerPluginHelp(): string {
  const plugins = PROVIDER_PLUGIN_CATALOG.map(
    (plugin) => `${plugin.label} (connect ${plugin.provider}; ${providerPluginSelector(plugin)})`,
  ).join(', ');
  return `  Plugins, installed separately: ${plugins}. Run agent-device plugins add <package>, then retry agent-device connect <provider> with your original arguments.`;
}
