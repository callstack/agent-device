import type { AppleLitPanel } from '@agent-device/contracts/interactor-types';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';

import { appleLitPanel, queryAppleDisplayInventory } from '../core/display-inventory.ts';
import { isAppleFoldableSimulator } from './orientation.ts';

/**
 * The panel a runner request names as lit.
 *
 * A runner cannot tell which panel of a multi-panel device is powered: it has no hinge to read, and
 * geometry decides nothing, because the dark panel's windows have perfectly good frames. So the host
 * reads the panel table for the request and sends the answer with it, and the runner books its surface
 * window against that fact rather than against the application's first window (ADR 0025).
 *
 * Which panel is lit is read fresh per request: that is exactly the fact a fold changes, and a cached
 * answer would send every later request to the panel that has gone dark. Whether the device has more
 * than one panel at all is hardware, so `isAppleFoldableSimulator` answers that from its own per-device
 * cache and a single-panel iPhone pays one table read for its whole session.
 *
 * Only a simulator the `fold` fact admits gets here. A physical device is folded by hand (ADR 0025),
 * no physical foldable leaf is in the supported matrix, and its runner keeps the historic first-window
 * route the same request always sent.
 */
export async function resolveRunnerRequestLitPanel(
  device: DeviceInfo,
  options: { signal?: AbortSignal } = {},
): Promise<AppleLitPanel | undefined> {
  if (!(await isAppleFoldableSimulator(device, options.signal))) return undefined;
  const inventory = await queryAppleDisplayInventory(device, { signal: options.signal });
  const panel = appleLitPanel(inventory);
  if (!panel && !inventory.unresolved) {
    emitDiagnostic({
      level: 'debug',
      phase: 'apple_runner_lit_panel_unresolved',
      data: {
        deviceId: device.id,
        litPanelCount: inventory.displays.filter((display) => display.power === 'lit').length,
        hint: 'The runner request carries no panel and keeps its first-window surface route; runner.log names the window frames it resolved.',
      },
    });
  }
  return panel;
}
