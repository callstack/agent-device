import { afterEach, beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { withDiagnosticsScope } from '@agent-device/host-kit/diagnostics';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  ANDROID_SNAPSHOT_HELPER_CAPTURE_PHASE as ONE_SHOT_PHASE,
  ANDROID_SNAPSHOT_HELPER_SESSION_CAPTURE_PHASE as SESSION_PHASE,
  snapshotAndroid,
} from '../snapshot.ts';
import { resetAndroidSnapshotHelperInstallCache } from '../snapshot-helper-install.ts';
import { resetAndroidSnapshotHelperSessions } from '../snapshot-helper-session-lifecycle.ts';
import { ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT } from './test-utils/android-snapshot-helper.ts';
import { createPersistentSnapshotHelperProvider } from './snapshot-helper-session.fixtures.ts';
import { mkdtempForTest } from './test-utils/tmp-dir.ts';

const device: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
};

beforeEach(async () => {
  await resetAndroidSnapshotHelperSessions();
  resetAndroidSnapshotHelperInstallCache();
});

afterEach(async () => {
  await resetAndroidSnapshotHelperSessions();
});

async function captureTimers(sessionResponseMode?: 'malformed') {
  const provider = createPersistentSnapshotHelperProvider({
    calls: [],
    spawnArgs: [],
    processes: [],
    sessionResponseMode,
    oneShotXml: '<hierarchy><node text="one-shot fallback" bounds="[0,0][10,10]" /></hierarchy>',
  });
  const tmpDir = await mkdtempForTest('agent-device-android-capture-timers-');
  const logPath = path.join(tmpDir, 'diag.ndjson');
  try {
    await withDiagnosticsScope(
      { debug: true, logPath, session: 'android-test', requestId: 'req-1', command: 'snapshot' },
      async () =>
        await snapshotAndroid(device, {
          helperAdb: provider,
          helperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT,
        }),
    );
    return (await fs.readFile(logPath, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { phase: string; data?: Record<string, unknown> })
      .filter(({ phase }) => phase === SESSION_PHASE || phase === ONE_SHOT_PHASE)
      .map(({ phase, data }) => ({ phase, transport: data?.transport, answered: data?.answered }));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

test('each helper capture timer records its transport and whether the session answered', async () => {
  assert.deepEqual(await captureTimers(), [
    { phase: SESSION_PHASE, transport: 'persistent-session', answered: true },
  ]);
  await resetAndroidSnapshotHelperSessions();
  assert.deepEqual(await captureTimers('malformed'), [
    { phase: SESSION_PHASE, transport: 'persistent-session', answered: false },
    { phase: ONE_SHOT_PHASE, transport: 'instrumentation', answered: undefined },
  ]);
});
