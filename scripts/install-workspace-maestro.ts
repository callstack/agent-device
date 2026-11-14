import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveUserConfigPath } from '@agent-device/host-kit/file';

/** Installs the explicitly selected workspace build into an isolated validation plugin store. */
export function installWorkspaceMaestro(env: NodeJS.ProcessEnv, source: boolean): void {
  if (!env.AGENT_DEVICE_HOME)
    throw new Error('Workspace plugin installation requires AGENT_DEVICE_HOME');
  const configPath = resolveUserConfigPath(env);
  const home = path.dirname(configPath);
  const installation = crypto.randomUUID();
  const directory = path.join(
    home,
    'plugins',
    installation,
    'node_modules',
    '@agent-device/maestro',
  );
  const workspace = path.resolve(import.meta.dirname, '../packages/maestro');
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
  const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      ...config,
      plugins: { ...config.plugins, '@agent-device/maestro': { installation } },
    }),
  );
}

if (process.argv[1] === import.meta.filename) installWorkspaceMaestro(process.env, false);
