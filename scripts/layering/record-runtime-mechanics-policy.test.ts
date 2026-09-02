import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordRuntimeDaemonMechanicsViolations } from './record-runtime-mechanics-policy.ts';

test('R16 rejects native mechanics in the daemon record owner without scanning prose', () => {
  const violations = recordRuntimeDaemonMechanicsViolations([
    {
      path: 'src/daemon/handlers/record-runtime.ts',
      source: `
        import fs from 'node:fs';
        import { runCmdBackground } from '@agent-device/host-kit/command';
        // setTimeout and runCmd are mechanics only when executable.
        const prose = 'spawn xcrun';
        setTimeout(() => runCmdBackground('xcrun', []), 1);
      `,
    },
    {
      path: 'packages/platform-apple/src/recording/runtime.ts',
      source: `setTimeout(() => runCmdBackground('xcrun', []), 1);`,
    },
  ]);
  assert.deepEqual(violations, [
    'src/daemon/handlers/record-runtime.ts: daemon record owner imports native mechanic node:fs',
    'src/daemon/handlers/record-runtime.ts: daemon record owner imports native mechanic @agent-device/host-kit/command',
    'src/daemon/handlers/record-runtime.ts: daemon record owner calls native mechanic setTimeout',
    'src/daemon/handlers/record-runtime.ts: daemon record owner calls native mechanic runCmdBackground',
  ]);
});

test('R16 rejects child termination and platform branching in daemon record owners', () => {
  const violations = recordRuntimeDaemonMechanicsViolations([
    {
      path: 'src/daemon/handlers/record-runtime.ts',
      source: `
        // child.kill(), process.kill(), and device.platform === 'apple' are prose.
        const prose = 'switch (device.platform)';
        child.kill('SIGINT');
        process.kill(pid, 'SIGTERM');
        if (device.platform === 'apple') runApple();
        switch (session.device.platform) {
          case 'android': runAndroid();
        }
        const family = session.device.platform;
        if (family !== 'web') runNative();
        resolveRecordingOutputPaths(req, session.device.platform);
      `,
    },
  ]);
  assert.equal(violations.length, 5);
  assert.match(violations.join('\n'), /child termination kill/);
  assert.match(violations.join('\n'), /platform comparison/);
  assert.match(violations.join('\n'), /platform switch/);
});
