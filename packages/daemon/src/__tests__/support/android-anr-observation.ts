import type { AndroidObservationAdapter } from '@agent-device/contracts/android-observation';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';

const CLOSE_APP_RECT = { x: 100, y: 600, width: 220, height: 80 };

/** The device point a tap on the ANR dialog's Close app button lands on. */
export const ANR_CLOSE_APP_TAP = { x: 210, y: 640 };

/**
 * An Android observation port with an "isn't responding" dialog owned by `dialogPackage` in focus.
 * A tap on Close app dismisses the dialog, and an opened app then holds focus.
 */
export function makeAnrDialogObservation(dialogPackage: string): {
  observation: AndroidObservationAdapter;
  taps: Array<{ x: number; y: number }>;
  openedApps: string[];
} {
  const taps: Array<{ x: number; y: number }> = [];
  const openedApps: string[] = [];
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
      rect: CLOSE_APP_RECT,
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
  const dismissed = () => taps.length > 0;
  const observation: AndroidObservationAdapter = {
    readAppState: async () => ({}),
    readBlockingDialog: async () =>
      dismissed()
        ? { status: 'clear' }
        : {
            status: 'dialog',
            focus: {
              package: dialogPackage,
              focusedWindow: `Application Not Responding: ${dialogPackage}`,
              raw: `mCurrentFocus=Window{ffeedd u0 Application Not Responding: ${dialogPackage}}`,
            },
          },
    readAppFocus: async (_device, appBundleId) => dismissed() && openedApps.includes(appBundleId),
    readSnapshotNodes: async () => (dismissed() ? [] : dialogNodes),
    tap: async (_device, x, y) => {
      taps.push({ x, y });
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    openApp: async (_device, appBundleId) => {
      openedApps.push(appBundleId);
    },
    readScreenSize: async () => ({ width: 1080, height: 1920 }),
    isPermissionPackage: async () => false,
  };
  return { observation, taps, openedApps };
}
