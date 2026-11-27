import type { GesturePlan } from '@agent-device/contracts/gesture-plan-types';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  isSplitViewContactOrigin,
  splitViewUnavailableError,
} from '@agent-device/contracts/scroll-gesture';
import { IOS_APPLE_DISPLAY_PROBE_TIMEOUT_MS } from '../core/config.ts';
import { readFoldablePanelTable } from './orientation.ts';

/** Converts a Split View contact to the runner's contact origin after checking the lit panel. */
export async function appleSplitViewRunnerPlan(
  device: DeviceInfo,
  plan: GesturePlan,
  signal: AbortSignal | undefined,
): Promise<GesturePlan> {
  if (plan.topology !== 'single' || !isSplitViewContactOrigin(plan.contactOrigin)) return plan;
  await requireAppleSplitViewPanel(device, signal);
  const { contactOrigin, ...runnerPlan } = plan;
  return contactOrigin === 'split-view-edge'
    ? { ...runnerPlan, contactOrigin: 'screen-edge' }
    : runnerPlan;
}

export async function requireAppleSplitViewPanel(
  device: DeviceInfo,
  signal: AbortSignal | undefined,
): Promise<void> {
  const table =
    device.kind === 'simulator'
      ? await readFoldablePanelTable(device, {
          signal,
          timeoutMs: IOS_APPLE_DISPLAY_PROBE_TIMEOUT_MS,
        })
      : ({ kind: 'single-panel' } as const);
  signal?.throwIfAborted();
  const lit = table.kind === 'multi-panel' ? table.inventory : undefined;
  if (!lit?.activeDisplay || lit.ambiguous || lit.activeDisplay.primary) {
    throw splitViewUnavailableError(
      table.kind === 'unreadable'
        ? 'The panel table did not answer, so the lit panel is unknown and nothing was sent'
        : 'Split View needs an iOS simulator with more than one panel and its inner panel lit',
      { deviceId: device.id, panelTable: table.kind },
    );
  }
}
