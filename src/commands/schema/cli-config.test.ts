import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { pluginHome } from '../../plugins/plugin.fixtures.ts';
import { resolveConfigBackedFlagDefaults, resolveUserConfigPath } from './cli-config.ts';

test('AGENT_DEVICE_HOME relocates user defaults; project and explicit config cannot select plugins', () => {
  const { home, env } = pluginHome();
  const cliFlags = { help: false, version: false, json: false };
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({ session: 'custom-home', plugins: {} }),
  );
  const options = { command: 'snapshot', cwd: home, cliFlags, env };
  assert.equal(resolveConfigBackedFlagDefaults(options).session, 'custom-home');
  fs.writeFileSync(path.join(home, 'agent-device.json'), JSON.stringify({ plugins: {} }));
  assert.throws(() => resolveConfigBackedFlagDefaults(options), { code: 'INVALID_ARGS' });
  const explicit = {
    ...options,
    cliFlags: { ...cliFlags, config: path.join(home, 'config.json') },
  };
  assert.throws(() => resolveConfigBackedFlagDefaults(explicit), { code: 'INVALID_ARGS' });
  const relative = { AGENT_DEVICE_HOME: './relative' };
  assert.throws(() => resolveUserConfigPath(relative), { code: 'INVALID_ARGS' });
});
