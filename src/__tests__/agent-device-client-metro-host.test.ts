import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { createAgentDeviceClient } from '../agent-device-client.ts';
import { createTransport } from './client-transport-fixture.ts';

test('closing a session drops its dev-server binding from the client host state dir', async () => {
  const stateDir = mkdtempForTestSync('agent-device-client-metro-host-');
  const hintsPath = path.join(stateDir, 'metro-sessions', 'qa.json');
  fs.mkdirSync(path.dirname(hintsPath), { recursive: true });
  fs.writeFileSync(hintsPath, JSON.stringify({ controlBaseUrl: 'http://127.0.0.1:8081' }));
  const setup = createTransport(async () => ({ ok: true, data: { session: 'qa' } }));
  const client = createAgentDeviceClient(
    { ...setup.config, stateDir: undefined },
    {
      transport: setup.transport,
      host: { env: { AGENT_DEVICE_STATE_DIR: stateDir }, cwd: stateDir },
    },
  );

  await client.sessions.close();

  assert.equal(fs.existsSync(hintsPath), false);
});
