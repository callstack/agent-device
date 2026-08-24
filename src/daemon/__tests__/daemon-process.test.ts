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

test('isAgentDeviceDaemonCommand matches daemons from branch-named checkouts', () => {
  assert.equal(
    isAgentDeviceDaemonCommand(
      '/usr/bin/node /Users/dev/worktrees/repair-evidence/dist/src/internal/daemon.js',
    ),
    true,
  );
  assert.equal(
    isAgentDeviceDaemonCommand('/usr/bin/node /Users/dev/wt/fix-1545/dist/src/daemon.js'),
    true,
  );
  assert.equal(
    isAgentDeviceDaemonCommand(
      '/usr/bin/node --experimental-strip-types /Users/dev/wt/fix-1545/src/daemon.ts',
    ),
    true,
  );
  assert.equal(
    isAgentDeviceDaemonCommand(
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\dev\\wt\\fix-1545\\dist\\src\\daemon.js"',
    ),
    true,
  );
});

test('isAgentDeviceDaemonCommand rejects commands that only resemble a daemon entry', () => {
  assert.equal(
    isAgentDeviceDaemonCommand('/usr/bin/node /Users/dev/wt/fix-1545/dist/src/daemon-worker.js'),
    false,
  );
  assert.equal(
    isAgentDeviceDaemonCommand('/usr/bin/node /Users/dev/wt/fix-1545/dist/src/internal/server.js'),
    false,
  );
  assert.equal(
    isAgentDeviceDaemonCommand('/usr/bin/node /Users/dev/wt/fix-1545/dist/src/bin.js'),
    false,
  );
  assert.equal(isAgentDeviceDaemonCommand('vim src/daemon.ts'), false);
});
