import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { publishFileSync, resolveUserConfigPath } from '@agent-device/host-kit/file';

// Workspace packages the device lanes may need installed as plugins, keyed by the id a lane names
// them with. `packages/<dir>` is the source directory; a plugin that reads asset directories at
// runtime names them so a store install copies what the plugin will look for.
type WorkspacePluginPackage = Readonly<{ dir: string; assets?: readonly string[] }>;

const WORKSPACE_PLUGIN_PACKAGES: Readonly<Record<string, WorkspacePluginPackage | undefined>> = {
  maestro: { dir: 'maestro' },
  replay: { dir: 'replay' },
  linux: { dir: 'platform-linux', assets: ['linux'] },
};

/**
 * Installs the explicitly selected workspace build into an isolated validation plugin store.
 *
 * The replay packages are staged for every run. A managed platform plugin is staged only when the
 * caller names it through `AGENT_DEVICE_WORKSPACE_PLUGINS`, because a platform plugin in the store
 * gives its family a runtime and interactor: a lane that does not expect the family to answer would
 * see a different daemon than the one it was written against.
 */
export function installWorkspaceReplayPlugins(
  env: NodeJS.ProcessEnv,
  source: boolean,
  extraPackageIds?: readonly string[],
): void {
  if (!env.AGENT_DEVICE_HOME)
    throw new Error('Workspace plugin installation requires AGENT_DEVICE_HOME');
  const configPath = resolveUserConfigPath(env);
  const home = path.dirname(configPath);
  const packageIds = [...(extraPackageIds ?? ['maestro', 'replay'])];
  const staged = packageIds.map((packageId) => ({
    packageId,
    installation: crypto.randomUUID(),
  }));
  try {
    for (const { packageId, installation } of staged)
      installWorkspacePlugin(source, home, packageId, installation);
    const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
    const selections = Object.fromEntries(
      staged.map(({ packageId, installation }) => [`@agent-device/${packageId}`, { installation }]),
    );
    publishFileSync({
      destination: configPath,
      contents: JSON.stringify({ ...config, plugins: { ...config.plugins, ...selections } }),
      mode: 0o600,
      preserveExistingMode: true,
    });
  } catch (error) {
    for (const { installation } of staged)
      fs.rmSync(path.join(home, 'plugins', installation), { recursive: true, force: true });
    throw error;
  }
}

function workspacePluginPackage(packageId: string): WorkspacePluginPackage {
  const entry = WORKSPACE_PLUGIN_PACKAGES[packageId];
  if (!entry) throw new Error(`Unknown workspace plugin package: ${packageId}`);
  return entry;
}

function installWorkspacePlugin(
  source: boolean,
  home: string,
  packageId: string,
  installation: string,
): void {
  const { dir, assets } = workspacePluginPackage(packageId);
  const directory = path.join(
    home,
    'plugins',
    installation,
    'node_modules',
    `@agent-device/${packageId}`,
  );
  const workspace = path.resolve(import.meta.dirname, `../packages/${dir}`);
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  if (source) fs.symlinkSync(workspace, directory, 'dir');
  else {
    fs.mkdirSync(directory);
    for (const shipped of ['dist', ...(assets ?? [])])
      fs.cpSync(path.join(workspace, shipped), path.join(directory, shipped), { recursive: true });
    const manifest = JSON.parse(fs.readFileSync(path.join(workspace, 'package.json'), 'utf8'));
    // The written file keeps every field the store reads before import: the `agent-device` claims and
    // `engines.node`, alongside the published `exports` that name the plugin entry.
    fs.writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify({
        name: manifest.name,
        version: manifest.version,
        type: 'module',
        ...(manifest.engines !== undefined ? { engines: manifest.engines } : {}),
        ...(manifest['agent-device'] !== undefined
          ? { 'agent-device': manifest['agent-device'] }
          : {}),
        exports: manifest.publishConfig.exports,
      }),
    );
  }
}

if (process.argv[1] === import.meta.filename)
  installWorkspaceReplayPlugins(
    process.env,
    false,
    process.env.AGENT_DEVICE_WORKSPACE_PLUGINS?.split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );
