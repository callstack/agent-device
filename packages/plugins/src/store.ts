import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AppError } from '@agent-device/kernel/errors';
import { isRecord } from '@agent-device/kernel/record';
import { runCmd } from '@agent-device/host-kit/command';
import {
  acquireProcessLock,
  publishFileSync,
  resolveUserConfigPath,
} from '@agent-device/host-kit/file';
import { readCurrentOwnerIdentity } from '@agent-device/host-kit/process';
import type { PluginPackageEntry } from './discovery.ts';
import {
  readPluginManifest,
  ROUTING_PROVIDER_IDENTITIES,
  type PluginManifest,
} from './manifest.ts';
import type { PluginCandidate } from './registry.ts';

type PluginSelection = {
  installation: string;
  version?: string;
  options?: Record<string, unknown>;
};
type PluginConfig = Record<string, unknown> & { plugins?: Record<string, PluginSelection> };
function readPluginConfig(env: NodeJS.ProcessEnv): PluginConfig {
  const configPath = resolveUserConfigPath(env);
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as PluginConfig;
    if (!isRecord(config) || (config.plugins !== undefined && !isRecord(config.plugins)))
      throw new AppError('INVALID_ARGS', 'Plugin config must contain an object');
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    if (error instanceof SyntaxError)
      throw new AppError('INVALID_ARGS', `Invalid plugin JSON: ${configPath}`, {}, error);
    throw error;
  }
}

function validatePluginSelection(name: string, selection: PluginSelection): void {
  if (
    !isPackageName(name) ||
    !isRecord(selection) ||
    typeof selection.installation !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(selection.installation) ||
    (selection.version !== undefined && !isVersionSelector(selection.version)) ||
    (selection.options !== undefined && !isRecord(selection.options))
  ) {
    throw new AppError('INVALID_ARGS', `Invalid plugin selection: ${name}`);
  }
}

type StoreInstallation = {
  name: string;
  version: string;
  directory: string;
  selection: PluginSelection;
  entry: PluginPackageEntry;
};

function storeHome(env: NodeJS.ProcessEnv): string {
  return path.dirname(resolveUserConfigPath(env));
}

function installationDirectory(home: string, name: string, installation: string): string {
  return path.join(home, 'plugins', installation, 'node_modules', name);
}

async function describeInstallation(
  name: string,
  directory: string,
  selection: PluginSelection,
): Promise<StoreInstallation> {
  const { discoverPluginEntry, readPackageJson } = await import('./discovery.ts');
  const packageJson = readPackageJson(directory);
  if (packageJson.name !== name)
    throw new AppError('INVALID_ARGS', `Plugin package identity mismatch: ${name}`);
  const version = typeof packageJson.version === 'string' ? packageJson.version : undefined;
  if (version === undefined) {
    throw new AppError('INVALID_ARGS', `Plugin package has no version: ${name}`, {
      reason: 'invalid_plugin',
    });
  }
  return { name, version, directory, selection, entry: discoverPluginEntry(directory) };
}

async function readInstallation(home: string, name: string, selection: PluginSelection) {
  validatePluginSelection(name, selection);
  return describeInstallation(
    name,
    installationDirectory(home, name, selection.installation),
    selection,
  );
}

async function loadInstallation({ name, directory, selection, entry }: StoreInstallation) {
  if (entry.kind === 'v1') {
    const { adaptLegacyPlugin } = await import('./legacy.ts');
    return adaptLegacyPlugin(entry.manifest, directory, selection.options);
  }
  const module = await import(pathToFileURL(entry.file).href);
  if (typeof module.default !== 'function')
    throw new AppError('INVALID_ARGS', `Plugin must export a default factory: ${name}`, {
      reason: 'invalid_plugin',
    });
  return await module.default(selection.options);
}

/**
 * The store's contribution to the provider registry, in package-name order. Nothing here runs
 * plugin code: a selection or package that cannot be read becomes a candidate that fails when
 * loaded, so one damaged installation never hides the others.
 */
export async function storePluginCandidates(env: NodeJS.ProcessEnv): Promise<PluginCandidate[]> {
  const home = storeHome(env);
  let selections: [string, PluginSelection][];
  try {
    selections = Object.entries(readPluginConfig(env).plugins ?? {});
  } catch (error) {
    return [{ source: 'store', load: () => Promise.reject(error) }];
  }
  const ordered = selections.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return await Promise.all(
    ordered.map(async ([name, selection]): Promise<PluginCandidate> => {
      try {
        const installation = await readInstallation(home, name, selection);
        return {
          source: 'store',
          package: name,
          version: installation.version,
          ...(installation.entry.kind === 'v1'
            ? { provider: installation.entry.manifest.agentDevicePlugin.provider }
            : {}),
          ...(selection.options ? { hostOptions: selection.options } : {}),
          load: () => loadInstallation(installation),
        };
      } catch (error) {
        return {
          source: 'store',
          package: name,
          ...(await readSelectionVersion(home, name, selection)),
          load: () => Promise.reject(error),
        };
      }
    }),
  );
}

// Only a selection that passed validation names a directory this process may read.
async function readSelectionVersion(
  home: string,
  name: string,
  selection: PluginSelection,
): Promise<{ version?: string }> {
  try {
    validatePluginSelection(name, selection);
    const { readPackageJson } = await import('./discovery.ts');
    const version = readPackageJson(
      installationDirectory(home, name, selection.installation),
    ).version;
    return typeof version === 'string' ? { version } : {};
  } catch {
    return {};
  }
}

/**
 * The v1 manifests in the store, read without executing anything, including those of a package
 * that also exports `./agent-device`; unreadable selections are skipped.
 */
export function legacyStoreManifests(env: NodeJS.ProcessEnv): PluginManifest[] {
  const home = storeHome(env);
  let selections: [string, PluginSelection][];
  try {
    selections = Object.entries(readPluginConfig(env).plugins ?? {});
  } catch {
    return [];
  }
  return selections.flatMap(([name, selection]) => {
    try {
      validatePluginSelection(name, selection);
      const manifest = readPluginManifest(
        installationDirectory(home, name, selection.installation),
      );
      return manifest.name === name ? [manifest] : [];
    } catch {
      return [];
    }
  });
}

export async function listPlugins(env: NodeJS.ProcessEnv, builtinProviders: readonly string[]) {
  const { claimProviderIds, resolveProviderPlugins } = await import('./registry.ts');
  const resolved = await resolveProviderPlugins([
    ...claimProviderIds(builtinProviders),
    ...(await storePluginCandidates(env)),
  ]);
  return resolved.inventory().map((entry) => ({
    name: entry.package,
    ...(entry.version !== undefined ? { version: entry.version } : {}),
    ...(entry.provider !== undefined ? { provider: entry.provider } : {}),
    compatible: entry.state === 'active',
    ...(entry.error ? { error: entry.error } : {}),
  }));
}

type PluginAction = 'add' | 'update' | 'remove';

function parsePluginRequest(action: PluginAction, input: string) {
  if (action === 'remove') return { name: input, version: undefined };
  const match =
    /^(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)(?:@(.+))?$/.exec(input);
  if (!match || !match[1] || (match[2] !== undefined && !isVersionSelector(match[2]))) {
    throw new AppError(
      'INVALID_ARGS',
      'Expected an npm package name, optionally followed by @version or @tag',
    );
  }
  if (action === 'update' && match[2] !== undefined)
    throw new AppError('INVALID_ARGS', 'update accepts a package name without a version');
  return { name: match[1], version: match[2] };
}

async function stagePlugin(
  home: string,
  name: string,
  version: string | undefined,
  env: NodeJS.ProcessEnv,
) {
  const installation = crypto.randomUUID();
  const project = path.join(home, 'plugins', installation);
  fs.mkdirSync(project, { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(
      path.join(project, 'package.json'),
      JSON.stringify({ private: true, dependencies: { [name]: version ?? 'latest' } }),
    );
    await runCmd(
      'npm',
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--global=false',
        '--prefix',
        project,
        '--workspaces=false',
        '--package-lock=true',
      ],
      { cwd: project, env, timeoutMs: 120_000 },
    );
    const staged = await describeInstallation(
      name,
      installationDirectory(home, name, installation),
      {
        installation,
      },
    );
    return { installation, project, entry: staged.entry };
  } catch (error) {
    fs.rmSync(project, { recursive: true, force: true });
    throw error;
  }
}

export async function changePlugin(
  action: PluginAction,
  input: string,
  env: NodeJS.ProcessEnv = process.env,
  reservedProviders: readonly string[],
): Promise<void> {
  const { name, version } = parsePluginRequest(action, input);
  const configPath = resolveUserConfigPath(env);
  const home = path.dirname(configPath);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const release = await acquireProcessLock({
    lockDirPath: path.join(home, 'plugins.lock'),
    owner: { ...readCurrentOwnerIdentity(), acquiredAtMs: Date.now() },
    description: 'plugin installation',
  });
  let staged: Awaited<ReturnType<typeof stagePlugin>> | undefined;
  try {
    const config = readPluginConfig(env);
    const selections = { ...config.plugins };
    const previous = Object.hasOwn(selections, name) ? selections[name] : undefined;
    if (action !== 'add' && !Object.hasOwn(selections, name))
      throw new AppError('INVALID_ARGS', `Plugin is not installed: ${name}`);
    if (action === 'remove') delete selections[name];
    else {
      const requested =
        action === 'update' && isVersionSelector(previous?.version) ? previous.version : version;
      staged = await stagePlugin(home, name, requested, env);
      assertUniqueLegacyProviders(
        [
          ...legacyStoreManifests(env).filter((manifest) => manifest.name !== name),
          ...(staged.entry.kind === 'v1' ? [staged.entry.manifest] : []),
        ],
        reservedProviders,
      );
      selections[name] = {
        installation: staged.installation,
        version: requested,
        ...(isRecord(previous?.options) ? { options: previous.options } : {}),
      };
    }
    publishFileSync({
      destination: configPath,
      contents: `${JSON.stringify({ ...config, plugins: selections }, null, 2)}\n`,
      mode: 0o600,
    });
  } catch (error) {
    if (staged) fs.rmSync(staged.project, { recursive: true, force: true });
    throw error;
  } finally {
    await release();
  }
}

// A v1 manifest names its provider before any code runs, so a clash is refused at install time. A
// v2 package names its provider only once loaded; the registry records a clash then.
function assertUniqueLegacyProviders(
  manifests: readonly PluginManifest[],
  reserved: readonly string[],
): void {
  const providers = new Set<string>([...ROUTING_PROVIDER_IDENTITIES, ...reserved]);
  for (const { agentDevicePlugin } of manifests) {
    if (providers.has(agentDevicePlugin.provider))
      throw new AppError(
        'INVALID_ARGS',
        `Duplicate provider plugin: ${agentDevicePlugin.provider}`,
        {
          reason: 'duplicate_provider',
        },
      );
    providers.add(agentDevicePlugin.provider);
  }
}

function isPackageName(value: string): boolean {
  return /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(value);
}

function isVersionSelector(value: unknown): value is string {
  return (
    typeof value === 'string' && /^[a-zA-Z0-9*^~<>=| .+-]+$/.test(value) && value.trim().length > 0
  );
}
