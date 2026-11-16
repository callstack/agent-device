import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { installWorkspaceReplayPlugins } from '../install-workspace-replay-plugins.ts';

afterEach(() => vi.restoreAllMocks());

test('failed second staging keeps the previous config and removes both new installations', () => {
  const home = mkdtempForTestSync('workspace-plugin-staging-');
  const config = '{"platform":"android","plugins":{"existing":{"installation":"kept"}}}';
  const file = path.join(home, 'config.json');
  fs.writeFileSync(file, config);
  const symlink = fs.symlinkSync;
  vi.spyOn(fs, 'symlinkSync').mockImplementation((target, destination, type) => {
    if (path.basename(String(target)) === 'replay') throw new Error('second staging failed');
    symlink(target, destination, type);
  });
  assert.throws(
    () => installWorkspaceReplayPlugins({ AGENT_DEVICE_HOME: home }, true),
    /second staging failed/,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), config);
  assert.deepEqual(fs.readdirSync(path.join(home, 'plugins')), []);
});

test('failed publication keeps the previous config and removes staged installations', () => {
  const home = mkdtempForTestSync('workspace-plugin-publish-');
  const config = '{"platform":"android"}';
  const file = path.join(home, 'config.json');
  fs.writeFileSync(file, config);
  vi.spyOn(fs, 'renameSync').mockImplementation(() => {
    throw new Error('publish failed');
  });
  assert.throws(
    () => installWorkspaceReplayPlugins({ AGENT_DEVICE_HOME: home }, true),
    /publish failed/,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), config);
  assert.deepEqual(fs.readdirSync(path.join(home, 'plugins')), []);
});
