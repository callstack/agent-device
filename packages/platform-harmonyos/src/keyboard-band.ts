import type { DeviceInfo } from '@agent-device/kernel/device';
import type { Rect, SnapshotKeyboardBandFact } from '@agent-device/kernel/snapshot';
import { runHarmonyShell } from './hdc.ts';

/**
 * The system window that hosts the on-screen keyboard. HarmonyOS keeps this SceneBoard panel
 * alive across captures, so presence alone says nothing: a positive rect is the visible band,
 * and a zero rect is the hidden keyboard.
 */
const KEYBOARD_PANEL_WINDOW_PREFIX = 'SCBKeyboardPanel';

const KEYBOARD_BAND_PROBE_TIMEOUT_MS = 5_000;

/**
 * The keyboard band this capture's producer measured, read from the window manager's public
 * dump (`hidumper -s WindowManagerService -a -a`). The IME never appears in the ArkUI layout
 * dump of the app behind it, so the tap guard's docked-tree derivation has no anchor to read;
 * this probe is the only public HDC channel that answers where the keyboard is. Never throws:
 * a failed probe publishes an `unmeasurable` fact, which leaves the guard's tree derivation
 * and its fail-open verdict exactly as they were before this probe existed.
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
 * Reads the keyboard band out of a WindowManagerService window table. The table lists the
 * panel on every device that shows a software keyboard; a device whose table omits it, or
 * whose panel row carries no readable rect, answers `unmeasurable` rather than a guess.
 */
export function harmonyKeyboardBandFromWindowDump(raw: string): SnapshotKeyboardBandFact {
  const rows = parseKeyboardPanelRows(raw);
  if (rows.length === 0) {
    return { kind: 'unmeasurable', reason: 'keyboard-window-not-listed' };
  }
  const measured = rows.filter((row) => row.rect !== undefined);
  if (measured.length === 0) {
    return { kind: 'unmeasurable', reason: 'keyboard-window-rect-unparseable' };
  }
  const visible = measured.find(isVisibleKeyboardPanelRow);
  if (visible?.rect) return { kind: 'visible', frame: visible.rect };
  return { kind: 'visibility-only', visible: false };
}

type KeyboardPanelRow = {
  rect: Rect | undefined;
  /** The window's z-order, when the table reports a readable one. */
  zOrder: number | undefined;
};

/**
 * A positive rect usually means the keyboard is showing, but the hidden panel must not
 * publish a phantom band from a stale rect. The dump reports hidden windows with a negative
 * z-order; when that column is readable, both signals must agree on "shown".
 */
function isVisibleKeyboardPanelRow(row: KeyboardPanelRow): boolean {
  const rect = row.rect;
  if (!rect || rect.width <= 0 || rect.height <= 0) return false;
  return row.zOrder === undefined || row.zOrder >= 0;
}

function parseKeyboardPanelRows(raw: string): KeyboardPanelRow[] {
  const rows: KeyboardPanelRow[] = [];
  for (const line of raw.split('\n')) {
    const name = line.trim().split(/\s+/)[0] ?? '';
    if (!name.startsWith(KEYBOARD_PANEL_WINDOW_PREFIX)) continue;
    rows.push({ rect: rectFromWindowRow(line), zOrder: zOrderFromWindowRow(line) });
  }
  return rows;
}

/** The first bracketed group of a window row: `[ x y w h ]`, ahead of offset and scale groups. */
const WINDOW_ROW_RECT = /\[\s*(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s*\]/;

function rectFromWindowRow(line: string): Rect | undefined {
  const match = WINDOW_ROW_RECT.exec(line);
  if (!match) return undefined;
  const [, x, y, width, height] = match;
  return {
    x: Number(x),
    y: Number(y),
    width: Number(width),
    height: Number(height),
  };
}

/**
 * The z-order column sits between the orientation column and the rect group. The name, six
 * id/flag columns, z-order, and orientation precede the rect, so the eighth token is the
 * z-order; anything else reads as unknown and leaves the rect as the only visibility signal.
 */
function zOrderFromWindowRow(line: string): number | undefined {
  const beforeRect = line.slice(0, line.indexOf('['));
  const columns = beforeRect.trim().split(/\s+/);
  const value = columns[7];
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}
