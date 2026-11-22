import {
  type RuntimeOperationFact,
  PLATFORM_RUNTIME_REASONS,
} from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';

/**
 * The operations a watchOS simulator admits. The watch keeps only what has a watch meaning: app
 * lifecycle, the runner tree, one-finger touch (tap, touch and hold, swipe, pan), the Digital Crown
 * (`scrollDirection` rotates it, `home` presses it), the Action Button, back, typing through the
 * system input sheet, screenshots, and screen recording (the host runs `simctl recordVideo` for any
 * Apple simulator, so the watch needs no runner recorder of its own). Every other operation is
 * refused here, so an operation added later stays closed on the watch until it has watch evidence
 * (#4738).
 */
const WATCH_OS_OPERATIONS = new Set<keyof PlatformRuntimeOperations>([
  'deployApp',
  'materializeAppSource',
  'deployMaterializedApp',
  'uninstallApp',
  'ensureReady',
  'bootTarget',
  'shutdownTarget',
  'resolveOpenTarget',
  'prepareApplicationOpen',
  'openApplication',
  'closeApplication',
  'finalizeApplicationClose',
  'prepareAppleRunner',
  'appState',
  'captureSnapshot',
  'findText',
  'querySelector',
  'readTextAtPoint',
  'focusPoint',
  'tapPoint',
  'tapElementSelector',
  'longPressPoint',
  'fillPoint',
  'typeText',
  'performGesturePlan',
  'performDirectionalFlingPlan',
  'gestureViewport',
  'scrollDirection',
  'back',
  'home',
  'actionButton',
  'captureScreenshot',
  'screenRecordingStart',
  'screenRecordingReattach',
  'screenRecordingCleanup',
]);

/** Why a watch refuses multi-touch, shared by the fact and the Apple adapter's own check. */
export const WATCH_OS_MULTI_TOUCH_UNSUPPORTED_HINT =
  'watchOS apps have no multi-touch gestures: the SDK has no pinch or rotate gesture, and two-finger pan belongs to the Zoom accessibility feature. Use swipe, gesture pan, or scroll (the Digital Crown).';

const WATCH_OS_REFUSALS: Partial<Record<keyof PlatformRuntimeOperations, string>> = {
  appSwitcher:
    'The watchOS App Switcher opens on a Digital Crown double-click, which XCUITest cannot press.',
  setOrientation: 'watchOS has no device orientation.',
};

const WATCH_OS_PHYSICAL_UNAVAILABLE = Object.freeze({
  available: false,
  reason: PLATFORM_RUNTIME_REASONS.unsupportedDeviceKind.reason,
  hint: 'watchOS is supported on simulators only. A physical Apple Watch reaches the Mac only through its paired iPhone.',
} as const);

function watchOsRefusal(operation: string): RuntimeOperationFact {
  return Object.freeze({
    available: false,
    reason: PLATFORM_RUNTIME_REASONS.unsupportedPlatformLeaf.reason,
    hint:
      WATCH_OS_REFUSALS[operation as keyof PlatformRuntimeOperations] ??
      'watchOS simulators support only watch interactions: app lifecycle, snapshot, press, swipe, scroll (the Digital Crown), back, home, typing, screenshots, and recording.',
  } as const);
}

/**
 * Applies the watchOS admission set to an Apple leaf's computed facts. An admitted operation, and a
 * refused one its own module already refuses, keep the module's fact and hint. Discovery never lists
 * a physical watch; one that reaches here anyway is refused everywhere.
 */
export function applyWatchOsOperationFacts<T extends Record<string, RuntimeOperationFact>>(
  device: DeviceInfo,
  operations: T,
): T {
  if (device.appleOs !== 'watchos') return operations;
  return Object.fromEntries(
    Object.entries(operations).map(([operation, fact]) => {
      if (device.kind !== 'simulator') return [operation, WATCH_OS_PHYSICAL_UNAVAILABLE];
      return [
        operation,
        WATCH_OS_OPERATIONS.has(operation as keyof PlatformRuntimeOperations) || !fact.available
          ? fact
          : watchOsRefusal(operation),
      ];
    }),
  ) as T;
}

/**
 * Drops the bound operations a watch refuses. The modules bind from their own facts, so the watch
 * admission must also narrow the binding for facts and operations to agree.
 */
export function bindWatchOsOperations<T extends object>(
  device: DeviceInfo,
  facts: Readonly<Record<string, RuntimeOperationFact>>,
  operations: T,
): T {
  if (device.appleOs !== 'watchos') return operations;
  return Object.fromEntries(
    Object.entries(operations).filter(([operation]) => facts[operation]?.available !== false),
  ) as T;
}
