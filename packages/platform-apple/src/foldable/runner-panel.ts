import type { RunnerCommand } from '@agent-device/apple-runner';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';

import { IOS_APPLE_DISPLAY_PROBE_TIMEOUT_MS } from '../core/config.ts';
import { appleLitPanel } from '../core/display-inventory.ts';
import { readFoldablePanelTable } from './orientation.ts';

const PANEL_TABLE_UNREADABLE_HINT =
  'The panel table is unreadable, so no lit panel can be named and nothing was sent. Retry; if it persists, run xcrun devicectl device info displays --device <udid>.';

/**
 * The lit panel a runner request names, read fresh per request because a fold changes it (ADR
 * 0025). The read never outlasts the request's `timeoutMs`. Undefined keeps the runner's historic
 * first-window route, which only a device not known to have more than one panel may take.
 */
export async function resolveRunnerRequestLitPanel(
  device: DeviceInfo,
  options: { signal?: AbortSignal; requestTimeoutMs?: number },
): Promise<RunnerCommand['litPanel']> {
  const read = await readFoldablePanelTable(device, {
    signal: options.signal,
    timeoutMs: Math.min(
      options.requestTimeoutMs ?? IOS_APPLE_DISPLAY_PROBE_TIMEOUT_MS,
      IOS_APPLE_DISPLAY_PROBE_TIMEOUT_MS,
    ),
  });
  if (read.kind === 'unreadable') {
    throw new AppError(
      'COMMAND_FAILED',
      `The panel table of ${device.name} did not answer, so the lit panel cannot be named`,
      {
        deviceId: device.id,
        reason: 'panel-table-unreadable',
        runnerErrorCode: 'APP_SCREEN_UNRESOLVED',
        dispatched: 'no',
        hint: PANEL_TABLE_UNREADABLE_HINT,
      },
    );
  }
  return read.kind === 'multi-panel' ? appleLitPanel(read.inventory) : undefined;
}
