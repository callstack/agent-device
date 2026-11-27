import type { AndroidObservationAdapter } from '@agent-device/contracts/android-observation';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';

/** The event a tap on the ANR dialog's Close app button records. */
export const ANR_CLOSE_APP_TAP_EVENT = 'tap 210 640';
/** The event recorded when a snapshot first shows the ANR dialog gone. */
export const ANR_DIALOG_CLEARED_EVENT = 'dialog cleared';

/**
 * An Android observation port with an "isn't responding" dialog owned by `dialogPackage` in focus.
 * The tap on Close app does not remove the dialog by itself: the next snapshot sees it gone, as
 * Android removes the dialog after it kills the process. `events` records taps, the dialog
 * clearing, and app launches in order.
 */
export function makeAnrDialogObservation(dialogPackage: string): {
  observation: AndroidObservationAdapter;
  events: string[];
} {
  const events: string[] = [];
  const dialogNodes: SnapshotNode[] = [
    {
      index: 0,
      ref: 'e0',
      type: 'android.widget.TextView',
      label: `${dialogPackage} isn't responding`,
      rect: { x: 50, y: 400, width: 500, height: 80 },
    },
    {
      index: 1,
      ref: 'e1',
      type: 'android.widget.Button',
      label: 'Close app',
      identifier: 'android:id/aerr_close',
      rect: { x: 100, y: 600, width: 220, height: 80 },
    },
    {
      index: 2,
      ref: 'e2',
      type: 'android.widget.Button',
      label: 'Wait',
      identifier: 'android:id/aerr_wait',
      rect: { x: 100, y: 700, width: 220, height: 80 },
    },
  ];
  let closeTapped = false;
  let cleared = false;
  const observation: AndroidObservationAdapter = {
    readAppState: async () => ({}),
    readBlockingDialog: async () =>
      cleared
        ? { status: 'clear' }
        : {
            status: 'dialog',
            focus: {
              package: dialogPackage,
              process: dialogPackage,
              focusedWindow: `Application Not Responding: ${dialogPackage}`,
              raw: `mCurrentFocus=Window{ffeedd u0 Application Not Responding: ${dialogPackage}}`,
            },
          },
    readAppFocus: async (_device, appBundleId) => cleared && events.includes(`open ${appBundleId}`),
    readSnapshotNodes: async () => {
      if (closeTapped && !cleared) {
        cleared = true;
        events.push(ANR_DIALOG_CLEARED_EVENT);
      }
      return cleared ? [] : dialogNodes;
    },
    tap: async (_device, x, y) => {
      events.push(`tap ${x} ${y}`);
      closeTapped = true;
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    openApp: async (_device, appBundleId) => {
      events.push(`open ${appBundleId}`);
    },
    readScreenSize: async () => ({ width: 1080, height: 1920 }),
    isPermissionPackage: async () => false,
  };
  return { observation, events };
}
