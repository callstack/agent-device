import type { RunnerCommand } from '@agent-device/apple-runner';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';

import { IOS_APPLE_DISPLAY_PROBE_TIMEOUT_MS } from '../core/config.ts';
import { appleLitPanel } from '../core/display-inventory.ts';
import { readFoldablePanelTable } from './orientation.ts';

const PANEL_TABLE_UNREADABLE_HINT =
  'The panel table is unreadable, so no lit panel can be named and nothing was sent. Retry; if it persists, run xcrun devicectl device info displays --device <udid>.';

/** Refuses a request whose lit panel cannot be named; nothing was sent. */
function panelTableRefusal(device: DeviceInfo, message: string): AppError {
  return new AppError('COMMAND_FAILED', message, {
    deviceId: device.id,
    reason: 'panel-table-unreadable',
    runnerErrorCode: 'APP_SCREEN_UNRESOLVED',
    dispatched: 'no',
    hint: PANEL_TABLE_UNREADABLE_HINT,
  });
}

/**
 * The lit panel a runner request names, read fresh per request because a fold changes it (ADR
 * 0025). The read never outlasts the request's `timeoutMs`. Undefined keeps the historic
 * first-window route whenever the read cannot name one lit panel. An unreadable table on a
 * known multi-panel device refuses instead.
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
    throw panelTableRefusal(
      device,
      `The panel table of ${device.name} did not answer, so the lit panel cannot be named`,
    );
  }
  return read.kind === 'multi-panel' ? appleLitPanel(read.inventory) : undefined;
}

/**
 * `command` with the lit panel named and the request budget the read left, measured on one clock.
 * A read that leaves no budget is refused before anything is sent.
 * Only a named panel charges probe time to the wire timeout; unnamed-panel requests keep the historic timeout and share the caller's AbortSignal.
 */
export async function nameRunnerRequestLitPanel(
  device: DeviceInfo,
  command: RunnerCommand,
  signal: AbortSignal | undefined,
): Promise<RunnerCommand> {
  const startedAt = Date.now();
  const litPanel = await resolveRunnerRequestLitPanel(device, {
    signal,
    requestTimeoutMs: command.timeoutMs,
  });
  if (!litPanel) return command;
  if (command.timeoutMs === undefined) return { ...command, litPanel };
  const timeoutMs = command.timeoutMs - (Date.now() - startedAt);
  if (timeoutMs < 1) {
    throw new AppError(
      'COMMAND_FAILED',
      `Reading the panel table of ${device.name} spent the request's ${command.timeoutMs} ms, so nothing was sent`,
      {
        deviceId: device.id,
        reason: 'panel-probe-budget-exhausted',
        dispatched: 'no',
        hint: 'Increase the request timeout to leave time for the command after reading the panel table.',
      },
    );
  }
  return { ...command, litPanel, timeoutMs };
}
