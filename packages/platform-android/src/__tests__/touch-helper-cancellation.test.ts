import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, vi } from 'vitest';
import './test-utils/android-host-test-setup.ts';
import { AppError } from '@agent-device/kernel/errors';
import { withAndroidAdbProvider } from '../adb-executor.ts';
import { resetAndroidSnapshotHelperSessions } from '../snapshot-helper-session-lifecycle.ts';
import { lowerAndroidTouchPlan } from '../touch-plan-lowering.ts';
import {
  executeAndroidTouchHelperPlan,
  readAndroidTouchHelperViewportReading,
} from '../touch-helper.ts';
import { ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT } from './test-utils/android-snapshot-helper.ts';
import {
  ANDROID_TOUCH_HELPER_MANIFEST as manifest,
  currentVersionAdb,
  flingPlan,
  makeIsolatedDevice,
} from './touch-helper.fixtures.ts';
import {
  createFakeTouchHelperSessionProvider,
  sessionHeaderResponse,
} from './touch-helper-session.fixtures.ts';

vi.mock('../helper-package-install.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../helper-package-install.ts')>();
  return {
    ...actual,
    resolveAndroidHelperArtifact: vi.fn(async () => ({
      apkPath: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT.apkPath,
      manifest: {
        ...manifest,
        sha256: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT.manifest.sha256,
      },
    })),
  };
});

beforeEach(async () => {
  delete process.env.AGENT_DEVICE_ANDROID_SNAPSHOT_HELPER_SESSION;
  await resetAndroidSnapshotHelperSessions();
});

afterEach(async () => {
  delete process.env.AGENT_DEVICE_ANDROID_SNAPSHOT_HELPER_SESSION;
  await resetAndroidSnapshotHelperSessions();
});

test('aborting an in-flight persistent gesture retires its helper without one-shot replay', async () => {
  const device = makeIsolatedDevice();
  const controller = new AbortController();
  let entered!: () => void;
  const injecting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const provider = createFakeTouchHelperSessionProvider((command, requestId) => {
    if (command.startsWith('gesture')) {
      entered();
      return undefined;
    }
    return sessionHeaderResponse({
      agentDeviceProtocol: 'android-snapshot-helper-v1',
      requestId,
      ok: 'true',
      x: '0',
      y: '0',
      width: '400',
      height: '800',
    });
  });
  let retired = false;
  let oneShot = false;
  await withAndroidAdbProvider(
    {
      ...provider,
      exec: currentVersionAdb(async (args, options) => {
        if (args.includes('force-stop')) retired = true;
        if (args.includes('instrument')) oneShot = true;
        return await provider.exec(args, options);
      }),
    },
    { serial: device.id },
    async () => {
      await readAndroidTouchHelperViewportReading(device, { helperSessionScope: 'daemon-session' });
      const pending = executeAndroidTouchHelperPlan(
        device,
        lowerAndroidTouchPlan(flingPlan()),
        controller.signal,
      );
      await injecting;
      const reason = new AppError('COMMAND_FAILED', 'deadline', {
        reason: 'daemon_request_timeout',
      });
      controller.abort(reason);
      await assert.rejects(
        pending,
        (error) => error instanceof AppError && error.details?.reason === 'daemon_request_timeout',
      );
      assert.equal(retired, true);
      assert.equal(oneShot, false);
    },
  );
});
