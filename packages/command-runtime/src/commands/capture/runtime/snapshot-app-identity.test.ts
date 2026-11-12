import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createLocalArtifactAdapter } from '@agent-device/host-kit/local-artifact-adapter';
import { createAgentDevice } from '../../../runtime.ts';
import { localCommandPolicy } from '@agent-device/contracts/command-policy';
import type { CommandSessionStore } from '@agent-device/contracts/runtime-contract';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';

test('an Android snapshot names the app it captured, not a session app that is not in front', async () => {
  const captureWith = async (overlay: { type: string; label: string; bundleId: string }) => {
    let stored: Parameters<CommandSessionStore['set']>[0] | undefined;
    const device = createAgentDevice({
      backend: {
        platform: 'android',
        captureSnapshot: async () => ({
          snapshot: makeSnapshotState(
            [
              {
                index: 0,
                depth: 0,
                type: 'TextView',
                label: '12:00',
                bundleId: 'com.android.systemui',
                systemBar: 'status',
              },
              { index: 1, depth: 0, ...overlay },
            ],
            { backend: 'android' },
          ),
          appName: 'Settings',
          appBundleId: 'com.android.settings',
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
  };

  const launcher = await captureWith({
    type: 'ScrollView',
    label: 'Workspace',
    bundleId: 'com.google.android.apps.nexuslauncher',
  });
  assert.equal(launcher.result.appName, 'com.google.android.apps.nexuslauncher');
  assert.equal(launcher.result.appBundleId, 'com.google.android.apps.nexuslauncher');
  assert.equal(launcher.stored?.appBundleId, 'com.android.settings');

  const settings = await captureWith({
    type: 'TextView',
    label: 'Network & internet',
    bundleId: 'com.android.settings',
  });
  assert.equal(settings.result.appName, 'Settings');
  assert.equal(settings.result.appBundleId, 'com.android.settings');
});
