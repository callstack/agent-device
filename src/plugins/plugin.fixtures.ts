import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ProviderProfileField } from '@agent-device/contracts/provider-profile-fields';
import { mkdtempForTestSync } from '../__tests__/test-utils/tmp-dir.ts';

export function pluginHome() {
  const home = mkdtempForTestSync('provider-plugins-');
  return { home, env: { AGENT_DEVICE_HOME: home } };
}

export function writePlugin(
  project: string,
  name = '@example/provider',
  apiVersion = 1,
  provider = 'example',
  source = 'throw new Error("evaluated");',
) {
  const directory = path.join(project, 'node_modules', name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({
      name,
      version: '1.2.3',
      type: 'module',
      agentDevicePlugin: { apiVersion, provider, entry: './plugin.js' },
    }),
  );
  fs.writeFileSync(path.join(directory, 'plugin.js'), source);
  return directory;
}

export function selectPlugin(
  home: string,
  name: string,
  provider: string,
  source: string,
  apiVersion = 1,
) {
  const installation = crypto.randomUUID();
  writePlugin(path.join(home, 'plugins', installation), name, apiVersion, provider, source);
  recordSelection(home, name, installation);
}

/** Installs `manifest` as-is, with an entry file that throws if evaluated. */
export function selectPluginManifest(
  home: string,
  manifest: {
    name: string;
    version: string;
    agentDevicePlugin: Record<string, unknown> & { entry: string };
  },
) {
  const installation = crypto.randomUUID();
  const directory = path.join(home, 'plugins', installation, 'node_modules', manifest.name);
  const entry = path.join(directory, manifest.agentDevicePlugin.entry);
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify(manifest));
  fs.writeFileSync(entry, 'throw new Error("evaluated");');
  recordSelection(home, manifest.name, installation);
}

function recordSelection(home: string, name: string, installation: string) {
  const configPath = path.join(home, 'config.json');
  const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
  config.plugins ??= {};
  config.plugins[name] = { installation, options: { region: 'eu' } };
  fs.writeFileSync(configPath, JSON.stringify(config));
}

export function registrationSource(provider: string, shutdownFile?: string) {
  return `import fs from 'node:fs';
    export default host => ({
      runtime: { provider: ${JSON.stringify(provider)},
        ownsDevice: () => false, getInteractor: () => undefined,
        deviceInventoryProvider: async () => [], leaseLifecycle: {},
        shutdown: async () => { ${shutdownFile ? `fs.writeFileSync(${JSON.stringify(shutdownFile)}, 'shutdown');` : ''} },
        options: host.options, env: host.env, createError: host.createError },
      platformModule: { owner: { kind: 'provider-runtime', provider: ${JSON.stringify(provider)}, instance: 'test' },
        loadRuntime: async () => { throw new Error('lazy'); } }
    });`;
}

const CONSUMED_PROFILE_FIELDS: Record<ProviderProfileField, 'consumed'> = {
  providerApp: 'consumed',
  providerOsVersion: 'consumed',
  providerDeviceType: 'consumed',
  providerProject: 'consumed',
  providerBuild: 'consumed',
  providerSessionName: 'consumed',
  providerDeviceOrientation: 'consumed',
  providerGeoLocation: 'consumed',
  providerTimezone: 'consumed',
  providerAppiumVersion: 'consumed',
  providerLanguage: 'consumed',
  providerLocale: 'consumed',
  providerNetworkProfile: 'consumed',
  providerCustomNetwork: 'consumed',
  providerNoResignApp: 'consumed',
  awsProjectArn: 'consumed',
  awsDeviceArn: 'consumed',
  awsAppArn: 'consumed',
  awsRegion: 'consumed',
  awsInteractionMode: 'consumed',
};

/** A `{ webDriver }` factory with a total field declaration; `connection` is a JS expression. */
export function webDriverPluginSource(
  provider: string,
  refused: readonly ProviderProfileField[] = [],
  connection?: string,
) {
  const fields = {
    ...CONSUMED_PROFILE_FIELDS,
    ...Object.fromEntries(refused.map((field) => [field, 'refused'])),
  };
  const webDriver = {
    provider,
    endpoint: 'https://webdriver.test/wd/hub/',
    platform: 'android',
    deviceName: provider,
    profileFields: { provider, label: provider, fields },
    requestPolicy: { retryAttempts: 0 },
  };
  return `export default (host) => ({ webDriver: ${JSON.stringify(webDriver)}${
    connection ? `, connection: ${connection}` : ''
  } });`;
}
