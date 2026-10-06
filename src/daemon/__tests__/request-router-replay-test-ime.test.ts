/**
 * #2997: a `test`/`replay` run on a physical Android device opts into the bundled test
 * IME with `--test-ime`, and that opt-in must arrive at the session open the flow itself
 * owns. The flag rides the request envelope through the production router into the
 * lifecycle binding, where the platform host performs the activation. Physical-device
 * defaults stay off: the activation seam fires only for an explicit opt-in.
 */
import { createTestDeviceInventoryGateways } from '../../__tests__/test-utils/device-inventory-gateways.ts';
import { beforeEach, expect, test, vi } from 'vitest';
import fs from 'node:fs';

import path from 'node:path';
import { getResolveTargetDeviceMock } from './request-router-dispatch-mocks.ts';

vi.mock('../device/device-ready.ts', () => ({ ensureDeviceReady: vi.fn(async () => {}) }));

vi.mock('../../platform-runtime-runtime-hints.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../platform-runtime-runtime-hints.ts')>();
  return { ...actual, applyRuntimeHintValues: vi.fn(async () => {}) };
});

// The IME seam itself talks adb; the router test asserts it is reached with the resolved
// device, so the mechanics module answers without a device attached.
const activateAndroidTestIme = vi.hoisted(() => vi.fn());
const restoreAndroidTestIme = vi.hoisted(() => vi.fn());
vi.mock('@agent-device/platform-android/mechanics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/platform-android/mechanics')>();
  return {
    ...actual,
    activateAndroidTestIme,
    restoreAndroidTestIme,
    resolveAndroidPackageForOpen: vi.fn(async () => undefined),
  };
});

import { ANDROID_DEVICE } from '../../__tests__/test-utils/device-fixtures.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { replayScriptSourceBundleFor } from '../../__tests__/test-utils/replay-script-source.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import {
  createRequestHandler,
  lifecycleDeviceRuntimeGateway,
} from './test-device-runtime-gateway.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

const mockActivateAndroidTestIme = vi.mocked(activateAndroidTestIme);
const mockRestoreAndroidTestIme = vi.mocked(restoreAndroidTestIme);
const mockResolveTargetDevice = vi.mocked(getResolveTargetDeviceMock());

beforeEach(() => {
  mockActivateAndroidTestIme.mockReset();
  mockActivateAndroidTestIme.mockResolvedValue({ outcome: 'settled' });
  mockRestoreAndroidTestIme.mockReset();
  mockRestoreAndroidTestIme.mockResolvedValue({ restored: false, reason: 'no-record' });
  mockResolveTargetDevice.mockReset();
  // A physical device, which is the #1198 default-off route this opt-in exists for.
  mockResolveTargetDevice.mockResolvedValue(ANDROID_DEVICE);
});

async function runAndroidFlowReplay(session: string, flags: Record<string, unknown>) {
  const root = mkdtempForTestSync('agent-device-replay-test-ime-');
  const replayPath = path.join(root, 'flow.ad');
  fs.writeFileSync(replayPath, 'open com.example.demo\n');
  const handler = createRequestHandler({
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    token: 'test-token',
    sessionStore: makeSessionStore('agent-device-replay-test-ime-'),
    leaseRegistry: new LeaseRegistry(),
    deviceRuntimeGateway: lifecycleDeviceRuntimeGateway,
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    trackDownloadableArtifact: () => 'artifact-id',
  });
  const response = await handler({
    token: 'test-token',
    session,
    command: 'replay',
    positionals: [replayPath],
    flags: {
      platform: 'android',
      replayScriptSource: replayScriptSourceBundleFor(replayPath),
      ...flags,
    },
    meta: { cwd: root, requestId: `replay-test-ime-${session}` },
  });
  return { response };
}

test('a replay run opted into --test-ime activates the test IME on the device its flow opens', async () => {
  const { response } = await runAndroidFlowReplay('replay-test-ime-on', { testIme: true });

  expect(response).toMatchObject({ ok: true });
  expect(mockActivateAndroidTestIme).toHaveBeenCalledTimes(1);
  expect(mockActivateAndroidTestIme.mock.calls[0]?.[0]).toMatchObject({
    id: ANDROID_DEVICE.id,
    platform: 'android',
  });
});

test('a replay run without --test-ime leaves the physical device on the real keyboard', async () => {
  const { response } = await runAndroidFlowReplay('replay-test-ime-default', {});

  expect(response).toMatchObject({ ok: true });
  expect(mockActivateAndroidTestIme).not.toHaveBeenCalled();
});
