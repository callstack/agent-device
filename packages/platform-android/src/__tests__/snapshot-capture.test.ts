import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'vitest';
import './test-utils/android-host-test-setup.ts';
import {
  androidSnapshotPublicationInput,
  androidSnapshotViewportFromHelperMetadata,
} from '../snapshot-capture.ts';
import { snapshotAndroid } from '../snapshot.ts';
import { resetAndroidSnapshotHelperInstallCache } from '../snapshot-helper-install.ts';
import { resetAndroidSnapshotHelperSessions } from '../snapshot-helper-session-lifecycle.ts';
import type { AndroidAdbExecutor } from '../snapshot-helper.ts';
import {
  androidSnapshotQualityDevice as device,
  androidSnapshotQualityHelperArtifact as helperArtifact,
} from './snapshot-quality-fixtures.ts';

const SCREEN_XML = '<hierarchy><node text="row" bounds="[0,0][1080,200]" /></hierarchy>';

beforeEach(async () => {
  await resetAndroidSnapshotHelperSessions();
  resetAndroidSnapshotHelperInstallCache();
});

afterEach(async () => {
  await resetAndroidSnapshotHelperSessions();
});

function helperAdbServing(
  display: { width?: number; height?: number } = {},
  xml: string = SCREEN_XML,
): AndroidAdbExecutor {
  const displayKeys =
    display.width !== undefined && display.height !== undefined
      ? [
          `INSTRUMENTATION_RESULT: displayWidth=${display.width}`,
          `INSTRUMENTATION_RESULT: displayHeight=${display.height}`,
        ]
      : [];
  const stdout = [
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
    'INSTRUMENTATION_RESULT: nodeCount=1',
    'INSTRUMENTATION_RESULT: truncated=false',
    'INSTRUMENTATION_RESULT: elapsedMs=12',
    'INSTRUMENTATION_RESULT: pixelDensity=2.625',
    ...displayKeys,
    'INSTRUMENTATION_CODE: 0',
  ].join('\n');
  return async (args) => {
    if (args.includes('--show-versioncode')) {
      return {
        exitCode: 0,
        stdout: 'package:com.callstack.agentdevice.snapshothelper versionCode:13004',
        stderr: '',
      };
    }
    if (args.includes('instrument')) {
      return { exitCode: 0, stdout, stderr: '' };
    }
    throw new Error(`unexpected helper adb args: ${args.join(' ')}`);
  };
}

// #3182: the published viewport comes from the display the helper measured, not from the tree, so a
// capture with content and a capture of an empty screen answer the same question.
test('snapshotAndroid publishes the display the helper measured (#3182)', async () => {
  const capture = await snapshotAndroid(device, {
    helperAdb: helperAdbServing({ width: 1080, height: 2400 }),
    helperArtifact,
  });

  assert.deepEqual(capture.viewport, { width: 1080, height: 2400 });
  // The response publishes the fact once. The raw display pair stays on the helper transport and the
  // backend metadata the response carries, so a consumer cannot read two copies of it.
  assert.equal(
    'displayWidth' in (capture.androidSnapshot as Record<string, unknown>),
    false,
    'the backend metadata carries no second copy of the display read',
  );
});

test('the Android viewport survives the publication adapter into the daemon capture (#3182)', async () => {
  const capture = await snapshotAndroid(device, {
    helperAdb: helperAdbServing({ width: 1080, height: 2400 }),
    helperArtifact,
  });

  assert.deepEqual(androidSnapshotPublicationInput(capture).viewport, {
    width: 1080,
    height: 2400,
  });
});

test('a helper with no display read leaves the Android viewport absent, never zero (#3182)', async () => {
  const capture = await snapshotAndroid(device, {
    helperAdb: helperAdbServing(),
    helperArtifact,
  });

  assert.equal(capture.viewport, undefined);
  assert.equal('viewport' in capture, false, 'absent is not the same as an empty box');
});

// The consequence the display read buys: the box is a property of the device, so the capture that
// reports nothing about the tree can still report the screen its (absent) bounds belonged to.
test('a presentation-failed Android capture still publishes the display it read (#3182)', async () => {
  const capture = await snapshotAndroid(device, {
    helperAdb: helperAdbServing({ width: 1080, height: 2400 }),
    helperArtifact,
    androidPresentation: { deadlineAtMs: 100, now: () => 100 },
  });

  assert.deepEqual(capture.nodes, [], 'the projection was discarded');
  assert.deepEqual(capture.viewport, { width: 1080, height: 2400 });
});

test('androidSnapshotViewportFromHelperMetadata refuses an unusable display read (#3182)', () => {
  assert.deepEqual(
    androidSnapshotViewportFromHelperMetadata({
      outputFormat: 'uiautomator-xml',
      displayWidth: 1080,
      displayHeight: 2400,
    }),
    { width: 1080, height: 2400 },
  );
  for (const unusable of [
    {},
    { displayWidth: 0, displayHeight: 2400 },
    { displayWidth: 1080, displayHeight: 0 },
    { displayWidth: -1, displayHeight: 2400 },
    { displayWidth: Number.NaN, displayHeight: 2400 },
    { displayWidth: Number.POSITIVE_INFINITY, displayHeight: 2400 },
  ]) {
    assert.equal(
      androidSnapshotViewportFromHelperMetadata({ outputFormat: 'uiautomator-xml', ...unusable }),
      undefined,
      JSON.stringify(unusable),
    );
  }
});

// The consumer this issue came from takes the extent of all rects as the screen. A display read
// answers that question without the tree, so a capture whose nodes carry no bounds at all still
// names the box those bounds would be measured in.
test('an Android capture with geometry-free nodes still publishes the display it read (#3182)', async () => {
  const capture = await snapshotAndroid(device, {
    helperAdb: helperAdbServing(
      { width: 1080, height: 2400 },
      '<hierarchy><node text="row" /></hierarchy>',
    ),
    helperArtifact,
  });

  assert.deepEqual(capture.viewport, { width: 1080, height: 2400 });
  assert.equal(
    capture.nodes.every((node) => node.rect === undefined),
    true,
    'the tree really carries no geometry',
  );
});
