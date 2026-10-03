import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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
