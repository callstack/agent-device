import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { resolveRemoteConfigProfile } from './remote-config.ts';

test('the released remote-config entry reads the process environment when none is given', () => {
  const root = mkdtempForTestSync('agent-device-sdk-remote-config-');
  const previous = process.env.AGENT_DEVICE_METRO_PREPARE_PORT;
  try {
    const configPath = path.join(root, 'demo.remote.json');
    fs.writeFileSync(configPath, JSON.stringify({ platform: 'ios' }), 'utf8');
    process.env.AGENT_DEVICE_METRO_PREPARE_PORT = '9191';

    const resolved = resolveRemoteConfigProfile({ configPath, cwd: root });

    assert.equal(resolved.profile.metroPreparePort, 9191);
  } finally {
    if (previous === undefined) delete process.env.AGENT_DEVICE_METRO_PREPARE_PORT;
    else process.env.AGENT_DEVICE_METRO_PREPARE_PORT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
