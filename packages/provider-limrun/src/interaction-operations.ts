import {
  bindProviderFocusInteractor,
  focusRuntimeOperationFacts,
} from '@agent-device/contracts/focus-runtime';
import { bindProviderScreenshotInteractor } from '@agent-device/contracts/screenshot-runtime';
import { bindProviderSnapshotInteractor } from '@agent-device/contracts/snapshot-runtime';
import {
  bindProviderTypeTextInteractor,
  typeTextRuntimeOperationFacts,
} from '@agent-device/contracts/type-text-runtime';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interaction';
import type { RuntimeOperationUnavailability } from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';

const available = Object.freeze({ available: true } as const);

/**
 * The interactor-backed interaction cells a live Limrun session serves: everything here rides
 * one provider interactor, and a live session always has one, so the cells are available
 * together. Extracted from the app-log owner because text/point interaction is not app-log
 * behavior — the owner module composes this, it does not define it.
 */
export function limrunInteractionOperationFacts(
  liveSessionUnavailable?: RuntimeOperationUnavailability,
) {
  const cell = liveSessionUnavailable ?? available;
  return Object.freeze({
    ...focusRuntimeOperationFacts({ focus: cell }),
    ...typeTextRuntimeOperationFacts({ type: cell }),
  });
}

/** Binds the interactor-backed operations (snapshot, screenshot, focus, type) for one session. */
export function bindLimrunInteractionOperations(
  params: Readonly<{
    device: DeviceInfo;
    signal: AbortSignal;
    getInteractor(device: DeviceInfo, runner?: RunnerContext): Interactor | undefined;
  }>,
) {
  const { device, signal } = params;
  const resolveInteractor = (runner: RunnerContext) => params.getInteractor(device, runner);
  return Object.freeze({
    ...bindProviderSnapshotInteractor({ device, signal, resolveInteractor }),
    ...bindProviderFocusInteractor({ device, signal, resolveInteractor }),
    ...bindProviderTypeTextInteractor({ device, signal, resolveInteractor }),
    ...bindProviderScreenshotInteractor({ device, signal, resolveInteractor }),
  });
}
