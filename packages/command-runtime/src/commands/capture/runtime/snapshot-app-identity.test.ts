import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createLocalArtifactAdapter } from '@agent-device/host-kit/local-artifact-adapter';
import { createAgentDevice } from '../../../runtime.ts';
import { localCommandPolicy } from '@agent-device/contracts/command-policy';
import type { CommandSessionStore } from '@agent-device/contracts/runtime-contract';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';

async function snapshotWithAppWindows(
  applicationWindowPackages: string[] | undefined,
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
          ...(applicationWindowPackages ? { applicationWindowPackages } : {}),
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

test('an Android snapshot names the captured app when the session app has no window in it', async () => {
  const { result, stored } = await snapshotWithAppWindows([
    'com.google.android.apps.nexuslauncher',
    'com.example.behind',
  ]);

  assert.equal(result.appName, 'com.google.android.apps.nexuslauncher');
  assert.equal(result.appBundleId, 'com.google.android.apps.nexuslauncher');
  assert.equal(stored?.appBundleId, 'com.android.settings');
});

test('an Android snapshot keeps the session app while one of its windows is captured', async () => {
  const { result } = await snapshotWithAppWindows([
    'com.google.android.permissioncontroller',
    'com.android.settings',
  ]);

  assert.equal(result.appName, 'Settings');
  assert.equal(result.appBundleId, 'com.android.settings');
});

test('a snapshot without application window facts names the session app', async () => {
  const { result } = await snapshotWithAppWindows(undefined);

  assert.equal(result.appName, 'Settings');
  assert.equal(result.appBundleId, 'com.android.settings');
});

test('an Android snapshot in a session with no app names the topmost captured app', async () => {
  const { result } = await snapshotWithAppWindows(
    ['com.google.android.apps.nexuslauncher', 'com.example.behind'],
    undefined,
  );

  assert.equal(result.appName, 'com.google.android.apps.nexuslauncher');
  assert.equal(result.appBundleId, 'com.google.android.apps.nexuslauncher');
});
