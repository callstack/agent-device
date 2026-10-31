import type { RunnerCommand } from '@agent-device/apple-runner';
import type { DeviceInfo } from '@agent-device/kernel/device';

import { appleLitPanel } from '../core/display-inventory.ts';
import { readFoldablePanelTable } from './orientation.ts';

/**
 * The lit panel a runner request names, read fresh per request because a fold changes it (ADR
 * 0025). Undefined keeps the runner's historic first-window route.
 */
export async function resolveRunnerRequestLitPanel(
  device: DeviceInfo,
  signal: AbortSignal | undefined,
): Promise<RunnerCommand['litPanel']> {
  const inventory = await readFoldablePanelTable(device, signal);
  return inventory ? appleLitPanel(inventory) : undefined;
}
