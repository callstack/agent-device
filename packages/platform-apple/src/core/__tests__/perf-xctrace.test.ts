import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mkdtempForTest } from '../../__tests__/tmp-dir.ts';
import { stopAppleXctracePerfCapture, type AppleXctracePerfCapture } from '../perf-xctrace.ts';

// Both xctrace exit waits now go through host-kit's settleWithin. The hand-rolled race they
// replaced left its timer armed for the whole budget after xctrace had already exited.
test('stopAppleXctracePerfCapture clears the grace deadline once xctrace exits', async () => {
  const tmpDir = await mkdtempForTest('agent-device-xctrace-stop-timer-');
  const tracePath = path.join(tmpDir, 'app.trace');
  await fs.writeFile(tracePath, 'trace', 'utf8');
  const child = { kill: vi.fn((_signal?: NodeJS.Signals) => true), pid: 1234 };
  const capture: AppleXctracePerfCapture = {
    kind: 'xctrace',
    mode: 'cpu-profile',
    template: 'Time Profiler',
    outPath: tracePath,
    appBundleId: 'com.example.app',
    deviceId: 'sim-1',
    platform: 'ios',
    targetPids: [111],
    targetProcesses: ['Example'],
    startedAt: '2026-04-01T10:00:00.000Z',
    child: child as unknown as AppleXctracePerfCapture['child'],
    wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
  };

  try {
    vi.useFakeTimers();
    try {
      await stopAppleXctracePerfCapture(capture);
      assert.equal(
        vi.getTimerCount(),
        0,
        'the exit wait cleared its deadline once the process reported its exit',
      );
    } finally {
      vi.useRealTimers();
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
