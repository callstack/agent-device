import assert from 'node:assert/strict';
import path from 'node:path';
import { expect, test } from 'vitest';
import { assertRpcOk } from './assertions.ts';
import {
  createAndroidRecordingScenarioHarness,
  withAndroidRecordingScenario,
} from './android-recording-fixtures.ts';
import { createAndroidRecordingProvider } from './android-recording-provider-fixtures.ts';
import { PROVIDER_SCENARIO_ANDROID } from './fixtures.ts';
import { PARALLEL_PROVIDER_SCENARIO_TIMEOUT_MS } from './test-timeouts.ts';
import { screenRecordingResourceStore } from '../../../src/daemon/screen-recording-resource-store.ts';
import { assertNoDaemonLeaks } from '../support/daemon-leak-oracle.ts';

// The `after-close` half of the #1781 B1 leak oracle, on a real daemon route.
// The three CLI daemon lanes only ever shut a daemon down, so this is the one
// place a closing session actually owns a resource: `record start` opens a
// record-only session with a live screen-recording handle, and the session-close
// teardown that #1325 added must finalize it. Removing that teardown step leaves
// the descriptor `lifecycle: "open"` and turns this test red.
test(
  'Provider-backed integration closing a recording session leaves no unfinalized capture handle',
  async () => {
    await withAndroidRecordingScenario(
      'agent-device-provider-scenario-close-leak-',
      async (tmpDir) => {
        const calls: string[][] = [];
        const outputPath = path.join(tmpDir, 'close-leak.mp4');
        const daemon = await createAndroidRecordingScenarioHarness({
          androidAdbProvider: () => createAndroidRecordingProvider({ calls }),
          deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
        });
        try {
          const started = await daemon.callCommand('record', ['start', outputPath], {
            platform: 'android',
            serial: PROVIDER_SCENARIO_ANDROID.id,
            recordingScope: 'device',
          });
          assert.equal(assertRpcOk<{ recording?: unknown }>(started).recording, 'started');

          const sessionDir = daemon.sessionDir('default');
          // The live handle is durable state: the oracle must be able to see the
          // unfinalized descriptor it will later refuse.
          assert.equal(
            screenRecordingResourceStore.read(screenRecordingResourceStore.resolvePath(sessionDir))
              .status,
            'decoded',
          );

          await daemon.callCommand('close', [], {
            platform: 'android',
            serial: PROVIDER_SCENARIO_ANDROID.id,
          });

          // `daemonPids: []` on purpose: this harness runs the daemon route
          // in-process, so there is no daemon process to own children and the
          // state-dir arm is the whole check here. The process arm is exercised by
          // the CLI lanes and pinned by daemon-leak-model.test.ts.
          await expect(
            assertNoDaemonLeaks({
              stateDir: path.dirname(sessionDir),
              sessionsDir: path.dirname(sessionDir),
              daemonPids: [],
              phase: 'after-close',
              closedSessions: [path.basename(sessionDir)],
              settleMs: 0,
            }),
          ).resolves.toBeUndefined();
        } finally {
          await daemon.close();
        }
      },
    );
  },
  PARALLEL_PROVIDER_SCENARIO_TIMEOUT_MS,
);
