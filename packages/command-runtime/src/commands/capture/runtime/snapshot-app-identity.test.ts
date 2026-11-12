import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createLocalArtifactAdapter } from '@agent-device/host-kit/local-artifact-adapter';
import { createAgentDevice } from '../../../runtime.ts';
import { localCommandPolicy } from '@agent-device/contracts/command-policy';
import type { CommandSessionStore } from '@agent-device/contracts/runtime-contract';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';

async function snapshotWithForeground(
  foregroundWindowPackage: string | undefined,
  sessionApp: { appName: string; appBundleId: string } | undefined = {
    appName: 'Settings',
    appBundleId: 'com.android.settings',
  },
) {
  let stored: Parameters<CommandSessionStore['set']>[0] | undefined;
  const device = createAgentDevice({
    backend: {
      platform: 'android',
      captureSnapshot: async () => ({
        snapshot: makeSnapshotState([{ index: 0, depth: 0, type: 'TextView', label: 'Gmail' }], {
          backend: 'android',
        }),
        androidSnapshot: {
          backend: 'android-helper',
          ...(foregroundWindowPackage ? { foregroundWindowPackage } : {}),
        },
        ...sessionApp,
      }),
    },
    artifacts: createLocalArtifactAdapter(),
    sessions: {
      get: () => undefined,
      set: (record) => {
        stored = record;
      },
    },
    policy: localCommandPolicy(),
  });
  const result = await device.capture.snapshot({ session: 'default', interactiveOnly: true });
  return { result, stored };
}

test('an Android snapshot names the captured foreground app when it is not the session app', async () => {
  const { result, stored } = await snapshotWithForeground('com.google.android.apps.nexuslauncher');

  // A foreign app has no label of its own here, so the header shows its package.
  assert.equal(result.appName, 'com.google.android.apps.nexuslauncher');
  assert.equal(result.appBundleId, 'com.google.android.apps.nexuslauncher');
  assert.equal(stored?.appBundleId, 'com.android.settings');
});

test('an Android snapshot keeps the session app label when the session app is in front', async () => {
  const { result } = await snapshotWithForeground('com.android.settings');

  assert.equal(result.appName, 'Settings');
  assert.equal(result.appBundleId, 'com.android.settings');
});

test('a snapshot without a foreground window fact names the session app', async () => {
  const { result } = await snapshotWithForeground(undefined);

  assert.equal(result.appName, 'Settings');
  assert.equal(result.appBundleId, 'com.android.settings');
});

test('an Android snapshot in a session with no app names the captured foreground app', async () => {
  const { result } = await snapshotWithForeground(
    'com.google.android.apps.nexuslauncher',
    undefined,
  );

  assert.equal(result.appName, 'com.google.android.apps.nexuslauncher');
  assert.equal(result.appBundleId, 'com.google.android.apps.nexuslauncher');
});

test('a repeated snapshot of a foreign foreground app is not acknowledged as unchanged', async () => {
  const snapshot = makeSnapshotState([{ index: 0, depth: 0, type: 'TextView', label: 'Gmail' }], {
    backend: 'android',
  });
  let stored: Parameters<CommandSessionStore['set']>[0] | undefined = {
    name: 'default',
    appBundleId: 'com.android.settings',
  };
  const device = createAgentDevice({
    backend: {
      platform: 'android',
      captureSnapshot: async () => ({
        snapshot,
        androidSnapshot: {
          backend: 'android-helper',
          foregroundWindowPackage: 'com.google.android.apps.nexuslauncher',
        },
        appBundleId: 'com.android.settings',
      }),
    },
    artifacts: createLocalArtifactAdapter(),
    sessions: {
      get: () => stored,
      set: (record) => {
        stored = record;
      },
    },
    policy: localCommandPolicy(),
  });

  await device.capture.snapshot({ session: 'default' });
  const result = await device.capture.snapshot({ session: 'default' });

  assert.equal(result.appBundleId, 'com.google.android.apps.nexuslauncher');
  assert.equal(result.unchanged, undefined);
});
