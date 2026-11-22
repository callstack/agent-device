import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempForTestSync } from './tmp-dir.ts';

export function pluginHome() {
  const home = mkdtempForTestSync('provider-plugins-');
  return { home, env: { AGENT_DEVICE_HOME: home } };
}

/**
 * Installs a plugin package: an `agent-device` metadata field, an `./agent-device` export, options
 * recorded. `exports` and `manifest` override the package.json fields, `files` adds extra files.
 * The metadata's static claims are derived from the source's `provider: "..."` unless `claims`
 * says otherwise.
 */
export function selectPlugin(
  home: string,
  name: string,
  source: string,
  options: {
    exports?: unknown;
    manifest?: Record<string, unknown>;
    files?: Record<string, string>;
    selectionOptions?: unknown;
    claims?: Record<string, unknown>;
  } = {},
) {
  const installation = crypto.randomUUID();
  const directory = path.join(home, 'plugins', installation, 'node_modules', name);
  fs.mkdirSync(directory, { recursive: true });
  const provider = /provider: "([a-z0-9-]+)"/.exec(source)?.[1];
  const agentDevice = options.claims ?? {
    apiVersion: 3,
    ...(provider ? { provider } : {}),
  };
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({
      name,
      version: '2.0.0',
      type: 'module',
      engines: { node: '>=22.12' },
      'agent-device': agentDevice,
      exports:
        'exports' in options ? options.exports : { './agent-device': { import: './plugin.mjs' } },
      ...options.manifest,
    }),
  );
  fs.writeFileSync(path.join(directory, 'plugin.mjs'), source);
  for (const [file, contents] of Object.entries(options.files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.writeFileSync(path.join(directory, file), contents);
  }
  recordSelection(home, name, installation, options.selectionOptions);
  return directory;
}

function recordSelection(
  home: string,
  name: string,
  installation: string,
  options: unknown = { region: 'eu' },
) {
  const configPath = path.join(home, 'config.json');
  const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
  config.plugins ??= {};
  config.plugins[name] = { installation, options };
  fs.writeFileSync(configPath, JSON.stringify(config));
}

/**
 * A plugin factory module. `extra` is spliced into the provider contribution, so a test can add
 * `connection` or override `credentials`; `shutdownFile` is written when the runtime shuts down.
 */
export function pluginSource(
  provider: string,
  options: { shutdownFile?: string; extra?: string; credentials?: string } = {},
) {
  return `import fs from 'node:fs';
    export default (options = {}) => ({
      apiVersion: 3,
      contributes: [{
        kind: 'provider',
        provider: ${JSON.stringify(provider)},
        credentials: ${options.credentials ?? '{ variables: [] }'},
        ${options.extra ?? ''}
        setup: async host => ({
          runtime: { provider: ${JSON.stringify(provider)},
            ownsDevice: () => false, getInteractor: () => undefined,
            deviceInventoryProvider: async () => [], leaseLifecycle: {},
            shutdown: async () => { ${options.shutdownFile ? `fs.writeFileSync(${JSON.stringify(options.shutdownFile)}, 'shutdown');` : ''} },
            options, hostEnv: host.env },
          platformModule: { owner: { kind: 'provider-runtime', provider: ${JSON.stringify(provider)}, instance: 'test' },
            loadRuntime: async () => { throw new Error('lazy'); } }
        })
      }]
    });`;
}
