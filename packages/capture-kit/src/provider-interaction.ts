import { bindProviderElementTextRuntime } from '@agent-device/contracts/element-text-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import { type RuntimeFacts, whenAdmitted } from '@agent-device/contracts/platform-runtime';
import { bindProviderFocusInteractor } from '@agent-device/contracts/focus-runtime';
import { bindProviderGestureInteractor } from '@agent-device/contracts/gesture-runtime';
import { bindProviderScrollInteractor } from '@agent-device/contracts/scroll-runtime';
import {
  bindProviderScreenshotInteractor,
  defaultCaptureOnly,
} from '@agent-device/contracts/screenshot-runtime';
import {
  bindProviderSnapshotInteractor,
  type SnapshotRuntimePresenter,
} from '@agent-device/contracts/snapshot-runtime';
import { bindProviderTypeTextInteractor } from '@agent-device/contracts/type-text-runtime';
import { bindProviderTouchInteractor } from '@agent-device/contracts/touch-runtime';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interactor-types';
import { type DeviceInfo } from '@agent-device/kernel/device';

export function bindProviderInteractionOperations(
  params: Readonly<{
    device: DeviceInfo;
    signal: AbortSignal;
    getInteractor(device: DeviceInfo, runner?: RunnerContext): Interactor;
    presentIosAcquisition?: SnapshotRuntimePresenter;
    screenshotHint: string;
    pause(milliseconds: number): Promise<void>;
    facts: RuntimeFacts<PlatformRuntimeOperations>['operations'];
  }>,
) {
  const { device, signal } = params;
  const resolveInteractor = (runner: RunnerContext) => params.getInteractor(device, runner);
  return Object.freeze({
    ...whenAdmitted(params.facts.readTextAtPoint, () =>
      bindProviderElementTextRuntime({ device, signal, resolveInteractor }),
    ),
    ...bindProviderSnapshotInteractor({
      device,
      signal,
      resolveInteractor,
      presentIosAcquisition: params.presentIosAcquisition,
    }),
    ...bindProviderFocusInteractor({ device, signal, resolveInteractor }),
    ...bindProviderTypeTextInteractor({ device, signal, resolveInteractor }),
    ...bindProviderTouchInteractor({
      device,
      signal,
      resolveInteractor,
      facts: params.facts,
      pause: params.pause,
    }),
    ...bindProviderScreenshotInteractor({
      device,
      signal,
      resolveInteractor,
      captureCapabilities: defaultCaptureOnly(params.screenshotHint),
    }),
    ...bindProviderGestureInteractor({
      device,
      signal,
      facts: params.facts,
      resolveInteractor,
    }),
    ...bindProviderScrollInteractor({ device, signal, resolveInteractor }),
  });
}

export async function loadProviderAndroidInteractionFacts() {
  const { providerAndroidInteractionFacts } =
    await import('./provider-android-interaction-facts.ts');
  return providerAndroidInteractionFacts;
}
export type ProviderAndroidInteractionFacts =
  typeof import('./provider-android-interaction-facts.ts').providerAndroidInteractionFacts;
