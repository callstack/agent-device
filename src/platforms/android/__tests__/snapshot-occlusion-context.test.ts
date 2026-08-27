import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { readSnapshotOcclusionContextEvidence } from '@agent-device/contracts/capture';
import { ANDROID_EMULATOR } from '../../../__tests__/test-utils/device-fixtures.ts';
import { ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT } from '../../../__tests__/test-utils/android-snapshot-helper.ts';
import { buildSnapshotState } from '../../../core/snapshot-state.ts';
import { coveredAndroidReplacementNodeIndexes } from '../../../snapshot/android-replacement-surface-occlusion.ts';
import { resetAndroidSnapshotHelperInstallCache } from '../snapshot-helper-install.ts';
import { resetAndroidSnapshotHelperSessions } from '../snapshot-helper-session-lifecycle.ts';
import type { AndroidAdbExecutor } from '../snapshot-helper.ts';
import { snapshotAndroid } from '../snapshot.ts';
import { androidSnapshotPublicationInput } from '../snapshot-capture.ts';
import {
  ANDROID_HELPER_INSTALLED_VERSION_PROBE,
  androidHelperInstrumentationOutput,
  isAndroidHelperRuntimeForceStop,
} from './snapshot-helper-session.fixtures.ts';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/command')>();
  return { ...actual, runCmd: vi.fn() };
});
vi.mock('../adb.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adb.ts')>();
  return { ...actual, sleep: vi.fn() };
});

afterEach(async () => {
  await resetAndroidSnapshotHelperSessions();
  resetAndroidSnapshotHelperInstallCache();
});

test('scoped Android captures retain broad off-wire context for daemon occlusion', async () => {
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" visible-to-user="true">
    <node class="android.view.ViewGroup" bounds="[0,0][390,844]" clickable="true" visible-to-user="true" drawing-order="2">
      <node class="android.widget.Button" text="Modal action" bounds="[24,420][366,480]" clickable="true" visible-to-user="true"/>
    </node>
    <node class="android.widget.Button" text="Behind the modal" bounds="[0,220][280,280]" clickable="true" visible-to-user="true" drawing-order="1"/>
  </node>
</hierarchy>`;
  const captured = await snapshotAndroid(ANDROID_EMULATOR, {
    helperAdb: oneShotHelper(xml),
    helperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT,
    scope: 'Behind the modal',
  });
  const daemonCapture = androidSnapshotPublicationInput(captured);
  const context = readSnapshotOcclusionContextEvidence(daemonCapture);

  assert.ok(context);
  assert.deepEqual(
    captured.nodes.map(({ index, type, label, hittable }) => ({ index, type, label, hittable })),
    [{ index: 0, type: 'android.widget.Button', label: 'Behind the modal', hittable: true }],
  );
  assert.deepEqual([...context.sourceIndexByNodeIndex], [[0, 3]]);
  assert.deepEqual(
    [
      ...coveredAndroidReplacementNodeIndexes(
        context.nodes,
        context.androidSiblingOrderByNodeIndex,
      ),
    ],
    [3],
  );

  const published = buildSnapshotState(daemonCapture, { snapshotScope: 'Behind the modal' });

  assert.equal(published.nodes.length, 1);
  assert.equal(published.nodes[0]?.label, 'Behind the modal');
  assert.equal(published.nodes[0]?.interactionBlocked, 'covered');
});

function oneShotHelper(xml: string): AndroidAdbExecutor {
  return async (args) => {
    if (args.includes('--show-versioncode')) return ANDROID_HELPER_INSTALLED_VERSION_PROBE;
    if (isAndroidHelperRuntimeForceStop(args)) {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (args.includes('instrument')) {
      return {
        exitCode: 0,
        stdout: androidHelperInstrumentationOutput(xml),
        stderr: '',
      };
    }
    throw new Error(`unexpected helper adb args: ${args.join(' ')}`);
  };
}
