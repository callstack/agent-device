import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isRecord } from '@agent-device/kernel/record';
import { AppError } from '@agent-device/kernel/errors';
import { runCmd } from '@agent-device/host-kit/command';
import {
  acquireProcessLock,
  publishFileSync,
  resolveUserConfigPath,
} from '@agent-device/host-kit/file';
import { readCurrentOwnerIdentity } from '@agent-device/host-kit/process';
import type { PluginCandidate } from './registry.ts';

export type PluginSelection = {
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

function storeHome(env: NodeJS.ProcessEnv): string {
  return path.dirname(resolveUserConfigPath(env));
}

function installationDirectory(home: string, name: string, installation: string): string {
  return path.join(home, 'plugins', installation, 'node_modules', name);
}

function isPackageName(value: string): boolean {
  return /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(value);
}

function isVersionSelector(value: unknown): value is string {
  return (
    typeof value === 'string' && /^[a-zA-Z0-9*^~<>=| .+-]+$/.test(value) && value.trim().length > 0
  );
}

type StoreInstallation = {
  name: string;
  version: string;
  directory: string;
  selection: PluginSelection;
  entry: string;
};

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

async function loadInstallation({ name, entry, selection }: StoreInstallation) {
  const module = await import(pathToFileURL(entry).href);
  if (typeof module.default !== 'function')
    throw new AppError('INVALID_ARGS', `Plugin must export a default factory: ${name}`, {
      reason: 'invalid_plugin',
    });
  return await module.default(selection.options);
}

/**
 * The store's contribution to the provider registry, in package-name order. Nothing here runs
 * plugin code: a selection or package that cannot be read becomes a candidate that fails when
 * loaded, so one damaged installation never hides the others. A store package names its provider
 * only once its factory runs, and the registry settles a duplicate then.
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
    ...(entry.backend !== undefined ? { backend: entry.backend } : {}),
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

/**
 * Installs, updates or removes one plugin selection. Install checks the staged package's identity
 * and version and resolves its entry to a readable file; the factory first runs when the daemon next
 * composes its plugins. A provider-id clash with another plugin or a built-in is the registry's to
 * settle then, by first claim.
 */
export async function changePlugin(
  action: PluginAction,
  input: string,
  env: NodeJS.ProcessEnv,
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
