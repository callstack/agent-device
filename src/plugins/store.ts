import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import { isRecord } from '@agent-device/kernel/record';
import { runCmd } from '@agent-device/host-kit/command';
import { acquireProcessLock, publishFileSync } from '@agent-device/host-kit/file';
import { readCurrentOwnerIdentity } from '@agent-device/host-kit/process';
import { resolveUserConfigPath } from '../commands/schema/cli-config.ts';
import { readPluginManifest, assertUniquePluginProviders } from './manifest.ts';

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

export function installedPlugins(env: NodeJS.ProcessEnv) {
  const home = path.dirname(resolveUserConfigPath(env));
  return Object.entries(readPluginConfig(env).plugins ?? {}).map(([name, selection]) =>
    readInstallation(home, name, selection),
  );
}

function readInstallation(home: string, name: string, selection: PluginSelection) {
  validatePluginSelection(name, selection);
  const directory = path.join(home, 'plugins', selection.installation, 'node_modules', name);
  const manifest = readPluginManifest(directory);
  if (manifest.name !== name)
    throw new AppError('INVALID_ARGS', `Plugin package identity mismatch: ${name}`);
  return { ...manifest, directory, selection };
}

export function listPlugins(env: NodeJS.ProcessEnv) {
  const home = path.dirname(resolveUserConfigPath(env));
  return Object.entries(readPluginConfig(env).plugins ?? {}).map(([name, selection]) => {
    try {
      const manifest = readInstallation(home, name, selection);
      return {
        name,
        version: manifest.version,
        provider: manifest.agentDevicePlugin.provider,
        compatible: true,
      };
    } catch (error) {
      return { name, compatible: false, error: normalizeError(error) };
    }
  });
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
    const manifest = readPluginManifest(path.join(project, 'node_modules', name));
    if (manifest.name !== name)
      throw new AppError('INVALID_ARGS', `Plugin package identity mismatch: ${name}`);
    return { installation, project, manifest };
  } catch (error) {
    fs.rmSync(project, { recursive: true, force: true });
    throw error;
  }
}

export async function changePlugin(
  action: PluginAction,
  input: string,
  env: NodeJS.ProcessEnv = process.env,
  reservedProviders: readonly string[] = [],
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
      const siblings = Object.entries(selections)
        .filter(([other]) => other !== name)
        .flatMap(([other, selection]) => {
          try {
            return [readInstallation(home, other, selection)];
          } catch {
            return [];
          }
        });
      assertUniquePluginProviders([...siblings, staged.manifest], reservedProviders);
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

function isPackageName(value: string): boolean {
  return /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(value);
}

function isVersionSelector(value: unknown): value is string {
  return (
    typeof value === 'string' && /^[a-zA-Z0-9*^~<>=| .+-]+$/.test(value) && value.trim().length > 0
  );
}
