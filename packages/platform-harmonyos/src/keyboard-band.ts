import type { DeviceInfo } from '@agent-device/kernel/device';
import type { SnapshotKeyboardBandFact } from '@agent-device/kernel/snapshot';
import { runHarmonyShell } from './hdc.ts';

/**
 * The system window that hosts the on-screen keyboard. HarmonyOS keeps this SceneBoard panel
 * alive across captures, so presence alone says nothing: the z-order column is the only
 * visibility signal (negative while hidden). The rect column is never read: on the measured
 * build the panel row reports the whole display in both states, so the table proves no band,
 * and a frame the table cannot prove would let the tap guard mark every on-screen point
 * keyboard-covered.
 */
const KEYBOARD_PANEL_WINDOW_PREFIX = 'SCBKeyboardPanel';

const KEYBOARD_BAND_PROBE_TIMEOUT_MS = 5_000;

/**
 * The keyboard visibility this capture's producer measured, read from the window manager's
 * public dump (`hidumper -s WindowManagerService -a -a`). The IME never appears in the ArkUI
 * layout dump of the app behind it, so the tap guard's docked-tree derivation has no anchor to
 * read; this probe is the only public HDC channel that answers whether the keyboard shows.
 * Never throws: a failed probe publishes an `unmeasurable` fact, which leaves the guard's tree
 * derivation and its fail-open verdict exactly as they were before this probe existed.
 */
export async function readHarmonyKeyboardBand(
  device: DeviceInfo,
): Promise<SnapshotKeyboardBandFact> {
  let stdout: string;
  try {
    const result = await runHarmonyShell(
      device,
      ['hidumper', '-s', 'WindowManagerService', '-a', '-a'],
      { timeoutMs: KEYBOARD_BAND_PROBE_TIMEOUT_MS },
    );
    if (result.exitCode !== 0) return keyboardWindowProbeFailed();
    stdout = result.stdout;
  } catch {
    return keyboardWindowProbeFailed();
  }
  return harmonyKeyboardBandFromWindowDump(stdout);
}

function keyboardWindowProbeFailed(): SnapshotKeyboardBandFact {
  return { kind: 'unmeasurable', reason: 'keyboard-window-probe-failed' };
}

/**
 * Reads keyboard visibility out of a WindowManagerService window table. The table lists the
 * panel on every device that shows a software keyboard; a device whose table omits it answers
 * `unmeasurable` rather than hidden, because a missing row is a dump-shape fact, not a
 * visibility measurement. A listed panel whose z-order column is unreadable also answers
 * `unmeasurable`: with the rect column never read, an unreadable z-order means the probe
 * measured nothing, and panel rows that disagree across displays mean it cannot say which
 * display it measured. The fact is always `visibility-only` — every measured build publishes
 * display-sized panel rows, so no public table carries a provable band and none is guessed.
 */
export function harmonyKeyboardBandFromWindowDump(raw: string): SnapshotKeyboardBandFact {
  const rows = parseKeyboardPanelRows(raw);
  if (rows.length === 0) {
    return { kind: 'unmeasurable', reason: 'keyboard-window-not-listed' };
  }
  const zOrders = rows.map((row) => row.zOrder);
  if (!zOrders.every(readableZOrder)) {
    return { kind: 'unmeasurable', reason: 'keyboard-window-zorder-unreadable' };
  }
  // Multi-display tables list one panel per display and the probe has no display scope, so
  // disagreeing rows mean the probe cannot say which display's keyboard it measured.
  const shown = zOrders.some((z) => z >= 0);
  if (shown && zOrders.some((z) => z < 0)) {
    return { kind: 'unmeasurable', reason: 'keyboard-window-zorder-conflict' };
  }
  return { kind: 'visibility-only', visible: shown };
}

type KeyboardPanelRow = {
  /** The window's z-order, when the table reports a readable one. */
  zOrder: number | undefined;
};

function parseKeyboardPanelRows(raw: string): KeyboardPanelRow[] {
  const rows: KeyboardPanelRow[] = [];
  for (const line of raw.split('\n')) {
    const name = line.trim().split(/\s+/)[0] ?? '';
    if (!name.startsWith(KEYBOARD_PANEL_WINDOW_PREFIX)) continue;
    rows.push({ zOrder: zOrderFromWindowRow(line) });
  }
  return rows;
}

function readableZOrder(z: number | undefined): z is number {
  return z !== undefined;
}

/**
 * The z-order column sits between the flag columns and the orientation column, ahead of the
 * rect group. The name, six id/flag columns, z-order, and orientation precede the rect, so the
 * eighth token is the z-order; anything else reads as unknown.
 */
function zOrderFromWindowRow(line: string): number | undefined {
  const beforeRect = line.slice(0, line.indexOf('['));
  const columns = beforeRect.trim().split(/\s+/);
  const value = columns[7];
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}
