import type { RunnerCommand } from '@agent-device/apple-runner';
import type { DeviceInfo } from '@agent-device/kernel/device';

import { IOS_APPLE_DISPLAY_PROBE_TIMEOUT_MS } from '../core/config.ts';
import { appleLitPanel } from '../core/display-inventory.ts';
import { readFoldablePanelTable } from './orientation.ts';

/**
 * The lit panel a runner request names, read fresh per request because a fold changes it (ADR
 * 0025). The read never outlasts the request's own `timeoutMs`. Undefined keeps the runner's
 * historic first-window route.
 */
export async function resolveRunnerRequestLitPanel(
  device: DeviceInfo,
  options: { signal?: AbortSignal; requestTimeoutMs?: number },
): Promise<RunnerCommand['litPanel']> {
  const inventory = await readFoldablePanelTable(device, {
    signal: options.signal,
    timeoutMs: Math.min(
      options.requestTimeoutMs ?? IOS_APPLE_DISPLAY_PROBE_TIMEOUT_MS,
      IOS_APPLE_DISPLAY_PROBE_TIMEOUT_MS,
    ),
  });
  return inventory ? appleLitPanel(inventory) : undefined;
}
