import type { GesturePlan } from '@agent-device/contracts/gesture-plan-types';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { splitViewUnavailableError } from '@agent-device/gestures/gesture-plan';
import { IOS_APPLE_DISPLAY_PROBE_TIMEOUT_MS } from '../core/config.ts';
import { readFoldablePanelTable } from './orientation.ts';

/**
 * The runner form of a Split View plan. Only a foldable simulator with its inner panel lit has
 * Split View; elsewhere the same bottom-edge touch opens Home or the app switcher, so the plan is
 * refused before any touch. The runner sends the contact as an ordinary screen-edge touch.
 */
export async function appleSplitViewRunnerPlan(
  device: DeviceInfo,
  plan: GesturePlan,
  signal: AbortSignal | undefined,
): Promise<GesturePlan> {
  if (plan.topology !== 'single' || plan.contactOrigin !== 'split-view-edge') return plan;
  const table =
    device.kind === 'simulator'
      ? await readFoldablePanelTable(device, {
          signal,
          timeoutMs: IOS_APPLE_DISPLAY_PROBE_TIMEOUT_MS,
        })
      : ({ kind: 'single-panel' } as const);
  const lit = table.kind === 'multi-panel' ? table.inventory : undefined;
  if (!lit?.activeDisplay || lit.ambiguous || lit.activeDisplay.primary) {
    throw splitViewUnavailableError(
      'Split View needs an iOS simulator with more than one panel and its inner panel lit',
      { deviceId: device.id },
    );
  }
  return { ...plan, contactOrigin: 'screen-edge' };
}
