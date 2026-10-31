import {
  assertProducedRunnerRequests,
  bindTestCommandHost,
  IOS_SIMULATOR,
} from '@agent-device/test-kit';
import { test, vi } from 'vitest';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import type { RunnerCommand } from '@agent-device/apple-runner';
import type { DeviceInfo } from '@agent-device/kernel/device';

vi.mock('../foldable/fold-helper-cache.ts', () => ({
  ensureFoldHelperBinary: vi.fn(async () => ({ path: '/cache/fold-helper' })),
}));
vi.mock('../core/devicectl.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/devicectl.ts')>();
  // The mock factory is hoisted above this file's imports, so the panel table it answers with is
  // read through the dynamic import the mock itself controls.
  const { IPHONE_DUO_OPEN } = await import('./display-fixtures.ts');
  return {
    ...actual,
    runIosDevicectlJsonRequest: vi.fn(async () => ({
      ok: true as const,
      payload: IPHONE_DUO_OPEN,
    })),
  };
});

import { createAppleInteractor } from '../interactor.ts';
import { recordingRunnerProvider, type RecordedRunnerCall } from './recording-runner-provider.ts';

bindTestCommandHost();

// The multi-panel half of the Apple runner request pin: the same production entry points as
// ./index-runner-requests.test.ts, driven for a device whose
// panel table reports two integrated panels, so the wire shape that carries the lit panel is pinned
// too. That file's entries are the single-panel requests, and they must stay panel-free.

const APP = 'com.example.app';

/** A device the `fold` fact admits: a foldable iPhone simulator in the default device set. */
const DUO_SIMULATOR: DeviceInfo = { ...IOS_SIMULATOR, name: 'iPhone Duo' };

type InteractorDrive = readonly [DeviceInfo, (interactor: Interactor) => Promise<unknown>];

const INTERACTOR_SITES: Record<string, InteractorDrive> = {
  'ios-foldable.interactions-tap.synthesized': [DUO_SIMULATOR, (i) => i.tap(10, 20)],
  'ios-foldable.interactor-snapshot.lit-panel': [
    DUO_SIMULATOR,
    (i) => i.snapshot({ appBundleId: APP, interactiveOnly: true }),
  ],
  // `keyboardDismiss` settles by fingerprinting screenshots, so it resolves a screen even though it
  // reads nothing: a clip or a settle loop taken from the dark panel reports success on nothing.
  'ios-foldable.interactor-keyboard-dismiss.lit-panel': [
    DUO_SIMULATOR,
    (i) => i.keyboardDismiss!(),
  ],
  // `readText` resolves the surface window to place the point it was handed, so the point means the
  // same screen on a foldable that the ref it came from was measured in.
  'ios-foldable.interactor-read-text.lit-panel': [
    DUO_SIMULATOR,
    (i) => i.readTextAtPoint!({ x: 10, y: 20 }, { appBundleId: APP }),
  ],
  // A request that resolves no screen carries no panel: alert, lifecycle, readiness and clipboard
  // traffic must stay byte-for-byte the request it was.
  'ios-foldable.alert.get': [DUO_SIMULATOR, (i) => i.readAlert!({ appBundleId: APP })],
};

test('a multi-panel device pins the runner request that carries its lit panel', async () => {
  const captured: Array<readonly [string, RunnerCommand]> = [];
  for (const [name, [device, drive]] of Object.entries(INTERACTOR_SITES)) {
    const calls: RecordedRunnerCall[] = [];
    await drive(
      createAppleInteractor(
        device,
        { appBundleId: APP },
        { env: process.env, cwd: process.cwd() },
        recordingRunnerProvider(calls, {
          alert: { message: 'Allow', items: ['Allow'] },
        }),
      ),
    );
    if (calls.length !== 1) throw new Error(`${name} sent ${calls.length} runner requests`);
    captured.push([name, calls[0]!.command]);
  }
  assertProducedRunnerRequests(import.meta.filename, captured);
});
