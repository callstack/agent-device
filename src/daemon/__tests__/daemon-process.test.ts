import assert from 'node:assert/strict';
import { test } from 'vitest';
import { isAgentDeviceDaemonCommand } from '../daemon-process.ts';

test('isAgentDeviceDaemonCommand matches expected daemon command', () => {
  assert.equal(isAgentDeviceDaemonCommand('node /tmp/agent-device/dist/src/daemon.js'), true);
  assert.equal(
    isAgentDeviceDaemonCommand('node /tmp/agent-device/dist/src/internal/daemon.js'),
    true,
  );
  assert.equal(
    isAgentDeviceDaemonCommand(
      'node --experimental-strip-types /worktrees/agent-device/src/daemon.ts',
    ),
    true,
  );
  assert.equal(isAgentDeviceDaemonCommand('node -e "setInterval(() => {}, 1000)"'), false);
});
