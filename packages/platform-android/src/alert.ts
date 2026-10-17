import { withDiagnosticTimer } from '@agent-device/host-kit/diagnostics';
import type {
  TreeAlertDriver,
  TreeAlertResult,
  TreeAlertSeam,
} from '@agent-device/capture-kit/alert-tree-driver';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import type { AlertAction } from '@agent-device/contracts/alert-contract';
import {
  chooseAndroidAlertButton,
  findAndroidAlertCandidate,
  type AndroidAlertButton,
  type AndroidAlertCandidate,
  type AndroidAlertInfo,
} from './alert-detection.ts';
import { backAndroid, pressAndroid } from './input-actions.ts';

/**
 * The Android alert legs: the shared tree-alert driver (`capture-kit`'s `runTreeAlertAction`,
 * the one poll/confirm/same-alert/response owner every tree-based backend rides) plus this
 * platform's own observation (`captureNodes` + the candidate reader) and acting policy (the
 * id-derived grant rank over the shared label vocabulary, the neutral-button/Back fallback).
 * The driver import is function-scoped: a static one would add a new eager module to the
 * mechanics façade and break its merge-base closure budget (ADR-0019).
 */

type AndroidAlertOptions = {
  timeoutMs?: number;
  /** The daemon request's cancellation; the driver hands it to every capture and press seam. */
  signal?: AbortSignal;
  captureNodes: (seam: TreeAlertSeam) => Promise<RawSnapshotNode[]>;
};

export type AndroidAlertResult = TreeAlertResult<AndroidAlertInfo, 'android'>;

export async function handleAndroidAlert(
  device: DeviceInfo,
  action: AlertAction,
  options: AndroidAlertOptions,
): Promise<AndroidAlertResult> {
  const driver: TreeAlertDriver<
    RawSnapshotNode[],
    AndroidAlertInfo,
    AndroidAlertButton,
    AndroidAlertCandidate,
    'android'
  > = {
    platform: 'android',
    timeoutMs: options.timeoutMs,
    ...(options.signal ? { signal: options.signal } : {}),
    capture: (seam) =>
      withDiagnosticTimer('snapshot_capture', () => options.captureNodes(seam), {
        backend: 'android',
        purpose: 'alert',
      }),
    // Android's dump either names a candidate or names none; it has no capture state that can
    // reach `undecided`.
    findCandidate: (nodes) => {
      const candidate = findAndroidAlertCandidate(nodes);
      return candidate ? { kind: 'alert', candidate } : { kind: 'none' };
    },
    choose: (candidate, act) => {
      const button = chooseAndroidAlertButton(candidate.buttons, act);
      if (button) return { kind: 'press', button };
      // No button states any leaving choice: dismissing an Android dialog is what the Back
      // key means. The refusal message and typed reason come from the driver, not from here.
      return act === 'dismiss' ? { kind: 'fallback', label: 'Back' } : null;
    },
    press: async (choice, seam) => {
      // The adb executor kills the child on abort, so the press transport stops with the
      // caller's cancellation; whether a canceled tap still reached the device is typed
      // upstream. The budget never stops a press — a chosen press is the action itself.
      if (choice.kind === 'press') {
        await pressAndroid(device, choice.button.x, choice.button.y, { signal: seam.signal });
        return;
      }
      await backAndroid(device, { signal: seam.signal });
    },
  };
  const { runTreeAlertAction } = await import('@agent-device/capture-kit/alert-tree-driver');
  return await runTreeAlertAction(action, driver);
}
