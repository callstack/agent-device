import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('../../../platforms/android/snapshot.ts', () => ({ snapshotAndroid: vi.fn() }));
vi.mock('../../../platforms/android/input-actions.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/android/input-actions.ts')>();
  return { ...actual, pressAndroid: vi.fn(), backAndroid: vi.fn() };
});

import { snapshotAndroid } from '../../../platforms/android/snapshot.ts';
import { pressAndroid } from '../../../platforms/android/input-actions.ts';
import { makeAndroidSession } from '../../../__tests__/test-utils/session-factories.ts';
import { SessionStore } from '../../session-store.ts';
import { handleAlertCommand } from '../snapshot-alert.ts';
import { makeAndroidSnapshotCapture } from '../../../__tests__/test-utils/android-snapshot-capture.ts';
import type { DaemonRequest } from '../../types.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(snapshotAndroid).mockReset();
  vi.mocked(pressAndroid).mockReset();
});

test('Android alert get does not choose an exactly covered candidate', async () => {
  vi.mocked(snapshotAndroid).mockResolvedValue(coveredAlertCapture() as never);

  const response = await handleAlertCommand(alertParams('get'));

  expect(response).toMatchObject({ ok: true, data: { action: 'get', alert: null } });
  expect(pressAndroid).not.toHaveBeenCalled();
});

test('Android alert accept does not tap an exactly covered candidate', async () => {
  vi.useFakeTimers();
  vi.mocked(snapshotAndroid).mockResolvedValue(coveredAlertCapture() as never);

  const response = handleAlertCommand(alertParams('accept'));
  const outcome = response.then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(3_500);
  const error = await outcome;
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain('alert not found');

  expect(pressAndroid).not.toHaveBeenCalled();
});

function alertParams(action: 'get' | 'accept') {
  const session = makeAndroidSession(`covered-alert-${action}`);
  const sessionStore = new SessionStore(path.join('/tmp', `covered-alert-${action}`));
  return {
    req: {
      token: 'test-token',
      session: session.name,
      command: 'alert',
      positionals: [action],
    } satisfies DaemonRequest,
    logPath: path.join('/tmp', `covered-alert-${action}.log`),
    sessionStore,
    session,
    device: session.device,
  };
}

function coveredAlertCapture() {
  const nodes = [
    {
      index: 0,
      type: 'android.widget.FrameLayout',
      rect: { x: 0, y: 0, width: 390, height: 844 },
    },
    {
      index: 1,
      parentIndex: 0,
      type: 'android.app.AlertDialog',
      rect: { x: 40, y: 280, width: 310, height: 160 },
    },
    {
      index: 2,
      parentIndex: 1,
      type: 'android.widget.TextView',
      identifier: 'android:id/alertTitle',
      label: 'Stale confirmation',
      rect: { x: 40, y: 280, width: 310, height: 80 },
    },
    {
      index: 3,
      parentIndex: 1,
      type: 'android.widget.Button',
      identifier: 'android:id/button1',
      label: 'OK',
      hittable: true,
      rect: { x: 40, y: 360, width: 310, height: 80 },
    },
    {
      index: 4,
      parentIndex: 0,
      type: 'android.view.ViewGroup',
    },
    {
      index: 5,
      parentIndex: 4,
      type: 'android.widget.Button',
      label: 'Foreground left',
      hittable: true,
      rect: { x: 40, y: 280, width: 155, height: 160 },
    },
    {
      index: 6,
      parentIndex: 4,
      type: 'android.widget.Button',
      label: 'Foreground right',
      hittable: true,
      rect: { x: 195, y: 280, width: 155, height: 160 },
    },
  ];
  return makeAndroidSnapshotCapture(nodes, {
    occlusionContext: {
      nodes,
      sourceIndexByNodeIndex: new Map(nodes.map((node) => [node.index, node.index])),
      androidSiblingOrderByNodeIndex: new Map([
        [1, { group: 0, order: 1 }],
        [4, { group: 0, order: 2 }],
      ]),
    },
  });
}
