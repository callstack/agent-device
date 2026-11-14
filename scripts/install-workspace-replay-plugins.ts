import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { publishFileSync, resolveUserConfigPath } from '@agent-device/host-kit/file';

/** Installs the explicitly selected workspace build into an isolated validation plugin store. */
export function installWorkspaceReplayPlugins(env: NodeJS.ProcessEnv, source: boolean): void {
  if (!env.AGENT_DEVICE_HOME)
    throw new Error('Workspace plugin installation requires AGENT_DEVICE_HOME');
  const configPath = resolveUserConfigPath(env);
  const home = path.dirname(configPath);
  const staged = ['maestro', 'replay'].map((packageId) => ({
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

function installWorkspacePlugin(
  source: boolean,
  home: string,
  packageId: string,
  installation: string,
): void {
  const directory = path.join(
    home,
    'plugins',
    installation,
    'node_modules',
    `@agent-device/${packageId}`,
  );
  const workspace = path.resolve(import.meta.dirname, `../packages/${packageId}`);
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  if (source) fs.symlinkSync(workspace, directory, 'dir');
  else {
    fs.mkdirSync(directory);
    fs.cpSync(path.join(workspace, 'dist'), path.join(directory, 'dist'), { recursive: true });
    const manifest = JSON.parse(fs.readFileSync(path.join(workspace, 'package.json'), 'utf8'));
    fs.writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify({
        name: manifest.name,
        version: manifest.version,
        type: 'module',
        exports: manifest.publishConfig.exports,
      }),
    );
  }
}

if (process.argv[1] === import.meta.filename) installWorkspaceReplayPlugins(process.env, false);
