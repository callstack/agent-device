import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'vitest';
import './test-utils/android-host-test-setup.ts';
import { snapshotAndroid } from '../snapshot.ts';
import { findAndroidAlertCandidate } from '../alert-detection.ts';
import {
  androidSnapshotQualityDevice,
  androidSnapshotQualityHelperAdb,
  androidSnapshotQualityHelperArtifact,
} from './snapshot-quality-fixtures.ts';
import { resetAndroidSnapshotHelperInstallCache } from '../snapshot-helper-install.ts';
import { resetAndroidSnapshotHelperSessions } from '../snapshot-helper-session-lifecycle.ts';

beforeEach(async () => {
  await resetAndroidSnapshotHelperSessions();
  resetAndroidSnapshotHelperInstallCache();
});

afterEach(async () => {
  await resetAndroidSnapshotHelperSessions();
});

test('snapshotAndroid publishes an Android helper quality verdict', async () => {
  const result = await snapshotAndroid(androidSnapshotQualityDevice, {
    helperAdb: androidSnapshotQualityHelperAdb(
      '<hierarchy><node text="quality" bounds="[0,0][10,10]" /></hierarchy>',
    ),
    helperArtifact: androidSnapshotQualityHelperArtifact,
  });

  assert.deepEqual((result as typeof result & { quality?: unknown }).quality, {
    state: 'healthy',
    backend: 'android-helper',
  });
});

test('snapshotAndroid discards the whole projection after a presentation deadline failure', async () => {
  const result = await snapshotAndroid(androidSnapshotQualityDevice, {
    helperAdb: androidSnapshotQualityHelperAdb(
      '<hierarchy><node text="deadline" bounds="[0,0][10,10]" /></hierarchy>',
    ),
    helperArtifact: androidSnapshotQualityHelperArtifact,
    androidPresentation: {
      deadlineAtMs: 100,
      now: () => 100,
    },
  });

  assert.deepEqual(result.nodes, []);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.androidSnapshot.presentationFailure, {
    phase: 'deadline',
    workUnits: 1,
    maxWorkUnits: 1024,
  });
  assert.deepEqual((result as typeof result & { quality?: unknown }).quality, {
    state: 'sparse',
    backend: 'android-helper',
    reason: 'Android snapshot presentation exceeded its cooperative deadline',
    reasonCode: 'presentation-failed',
  });
});

test('snapshotAndroid preserves a focused native dialog for alert detection', async () => {
  const result = await snapshotAndroid(androidSnapshotQualityDevice, {
    helperAdb: androidSnapshotQualityHelperAdb(`
      <hierarchy>
        <node package="com.example.app" class="android.widget.FrameLayout" bounds="[0,0][390,844]" visible-to-user="true" window-index="0" window-type="1" window-layer="0" window-active="false" window-focused="false">
          <node class="android.widget.Button" text="Underlying" bounds="[20,100][200,160]" clickable="true" visible-to-user="true" />
        </node>
        <node package="com.example.app" class="android.app.AlertDialog" bounds="[40,240][350,600]" visible-to-user="true" window-index="1" window-type="1" window-layer="1" window-active="true" window-focused="true">
          <node class="android.widget.FrameLayout" resource-id="android:id/parentPanel" bounds="[40,240][350,600]" visible-to-user="true">
            <node class="android.widget.TextView" resource-id="android:id/alertTitle" text="Automation confirmation" bounds="[60,280][330,330]" visible-to-user="true" />
            <node class="android.widget.Button" resource-id="android:id/button1" text="OK" bounds="[220,520][320,570]" clickable="true" visible-to-user="true" />
          </node>
        </node>
      </hierarchy>
    `),
    helperArtifact: androidSnapshotQualityHelperArtifact,
  });

  assert.deepEqual(result.quality, { state: 'healthy', backend: 'android-helper' });
  const candidate = findAndroidAlertCandidate(result.nodes);
  assert.equal(candidate?.alert.title, 'Automation confirmation');
  assert.deepEqual(candidate?.alert.buttons, ['OK']);
});
