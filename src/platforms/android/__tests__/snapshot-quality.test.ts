import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'vitest';
import { snapshotAndroid } from '../snapshot.ts';
import {
  androidSnapshotQualityDevice,
  androidSnapshotQualityHelperAdb,
  androidSnapshotQualityHelperArtifact,
} from './snapshot-quality-fixtures.ts';
import { resetAndroidSnapshotHelperInstallCache } from '../snapshot-helper-install.ts';
import { resetAndroidSnapshotHelperSessions } from '../snapshot-helper-session.ts';

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
  assert.deepEqual((result as typeof result & { quality?: unknown }).quality, {
    state: 'sparse',
    backend: 'android-helper',
    reason: 'Android snapshot presentation exceeded its cooperative deadline',
    reasonCode: 'presentation-failed',
  });
});
