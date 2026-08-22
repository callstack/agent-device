import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import {
  readSnapshotClickabilityEvidence,
  type SnapshotClickabilityEvidence,
} from '@agent-device/contracts/capture';
import { snapshotAndroid } from '../snapshot.ts';
import { buildUiHierarchySnapshot, parseUiHierarchyTree } from '../ui-hierarchy.ts';
import { buildAndroidSnapshotClickabilityEvidence } from '../snapshot-clickability.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { AndroidAdbExecutor } from '../snapshot-helper.ts';
import { ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT } from '../../../__tests__/test-utils/android-snapshot-helper.ts';
import { resetAndroidSnapshotHelperInstallCache } from '../snapshot-helper-install.ts';
import { resetAndroidSnapshotHelperSessions } from '../snapshot-helper-session-lifecycle.ts';

vi.mock('../../../utils/exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/exec.ts')>();
  return { ...actual, runCmd: vi.fn() };
});
vi.mock('../adb.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adb.ts')>();
  return { ...actual, sleep: vi.fn() };
});

const device: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
};

afterEach(() => {
  resetAndroidSnapshotHelperInstallCache();
  resetAndroidSnapshotHelperSessions();
});

test('retains Android helper clickable facts from the same hierarchy projection', () => {
  const built = buildUiHierarchySnapshot(
    parseUiHierarchyTree(`<hierarchy>
      <node resource-id="true-node" bounds="[0,0][20,20]" clickable="true" />
      <node resource-id="false-node" bounds="[0,20][20,40]" clickable="false" focusable="true" />
      <node resource-id="absent-node" bounds="[0,40][20,60]" />
    </hierarchy>`),
    undefined,
    { raw: true },
  );
  const evidence = buildAndroidSnapshotClickabilityEvidence(built);
  const publicSnapshot = { nodes: built.nodes };
  assert.equal(evidence.kind, 'exact');
  if (evidence.kind !== 'exact') throw new Error('Android evidence must be exact');

  assert.deepEqual(
    [...evidence.clickableByNodeIndex.entries()],
    [
      [0, true],
      [1, false],
      [2, false],
    ],
  );
  assert.equal(publicSnapshot.nodes[1]?.hittable, true);
  assert.equal('clickable' in (publicSnapshot.nodes[1] ?? {}), false);
  assert.equal(readSnapshotClickabilityEvidence(publicSnapshot), undefined);
});

test('snapshotAndroid captures the hierarchy once and retains clickability off-wire', async () => {
  let hierarchyCaptures = 0;
  const helperAdb: AndroidAdbExecutor = async (args) => {
    if (args.includes('--show-versioncode')) {
      return {
        exitCode: 0,
        stdout: 'package:com.callstack.agentdevice.snapshothelper versionCode=13004',
        stderr: '',
      };
    }
    if (args[0] === 'shell' && args[1] === 'am' && args[2] === 'force-stop') {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'install') {
      return { exitCode: 0, stdout: 'Success', stderr: '' };
    }
    if (args.includes('instrument')) {
      hierarchyCaptures += 1;
      return { exitCode: 0, stdout: helperOutput(), stderr: '' };
    }
    throw new Error(`unexpected helper adb args: ${args.join(' ')}`);
  };

  const result = await snapshotAndroid(device, {
    helperAdb,
    helperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT,
    raw: true,
  });
  const evidence = readSnapshotClickabilityEvidence(result);

  assert.equal(hierarchyCaptures, 1);
  assert.equal(evidence?.kind, 'exact');
  assert.deepEqual(
    [
      ...(
        evidence as Extract<SnapshotClickabilityEvidence, { kind: 'exact' }>
      ).clickableByNodeIndex.values(),
    ],
    [false, true, false],
  );
  assert.equal(JSON.stringify(result).includes('clickable'), false);
});

function helperOutput(): string {
  const xml = `<hierarchy>
    <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" clickable="false">
      <node class="android.widget.Button" text="Save" bounds="[20,120][200,180]" clickable="true" />
      <node class="android.widget.TextView" text="Read only" bounds="[20,200][200,260]" clickable="false" />
    </node>
  </hierarchy>`;
  return [
    'INSTRUMENTATION_STATUS: agentDeviceProtocol=android-snapshot-helper-v1',
    'INSTRUMENTATION_STATUS: helperApiVersion=1',
    'INSTRUMENTATION_STATUS: outputFormat=uiautomator-xml',
    'INSTRUMENTATION_STATUS: chunkIndex=0',
    'INSTRUMENTATION_STATUS: chunkCount=1',
    `INSTRUMENTATION_STATUS: payloadBase64=${Buffer.from(xml, 'utf8').toString('base64')}`,
    'INSTRUMENTATION_STATUS_CODE: 1',
    'INSTRUMENTATION_RESULT: agentDeviceProtocol=android-snapshot-helper-v1',
    'INSTRUMENTATION_RESULT: helperApiVersion=1',
    'INSTRUMENTATION_RESULT: ok=true',
    'INSTRUMENTATION_RESULT: outputFormat=uiautomator-xml',
    'INSTRUMENTATION_RESULT: waitForIdleTimeoutMs=0',
    'INSTRUMENTATION_RESULT: timeoutMs=8000',
    'INSTRUMENTATION_RESULT: maxDepth=128',
    'INSTRUMENTATION_RESULT: maxNodes=5000',
    'INSTRUMENTATION_RESULT: rootPresent=true',
    'INSTRUMENTATION_RESULT: captureMode=interactive-windows',
    'INSTRUMENTATION_RESULT: windowCount=1',
    'INSTRUMENTATION_RESULT: nodeCount=3',
    'INSTRUMENTATION_RESULT: truncated=false',
    'INSTRUMENTATION_RESULT: elapsedMs=12',
    'INSTRUMENTATION_CODE: 0',
  ].join('\n');
}
