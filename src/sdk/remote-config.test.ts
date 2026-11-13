import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { resolveRemoteConfigProfile } from './remote-config.ts';

test('the public remote-config resolver uses each supplied environment and cwd', () => {
  const root = mkdtempForTestSync('agent-device-sdk-remote-config-');
  fs.writeFileSync(path.join(root, 'demo.remote.json'), JSON.stringify({ platform: 'ios' }));
  const resolve = (port: string) =>
    resolveRemoteConfigProfile({
      configPath: 'demo.remote.json',
      cwd: root,
      env: { AGENT_DEVICE_METRO_PREPARE_PORT: port },
    });
  assert.equal(resolve('9191').profile.metroPreparePort, 9191);
  assert.equal(resolve('9292').profile.metroPreparePort, 9292);
});
