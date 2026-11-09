import type { DeviceInfo } from '@agent-device/kernel/device';
import type { Rect, SnapshotKeyboardBandFact } from '@agent-device/kernel/snapshot';
import { runHarmonyShell } from './hdc.ts';

/**
 * The system window that hosts the on-screen keyboard. HarmonyOS keeps this SceneBoard panel
 * alive across captures, so presence alone says nothing: the z-order column decides visibility
 * (negative while hidden), and the rect is a band only when the table proves it smaller than
 * the display — current builds report the full display rect in both states.
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
 * A rect at or above this share of the display's area is the window manager's full-surface
 * container, not the key plane. On JUY-AL50 7.0.0.111 the panel row reports the whole display
 * whether the keyboard shows or hides, and the key plane lives inside the window's own surface
 * where no public dump reads it — `softKeyboard1` and `SCBKeyboardPanel` both answer
 * `[0 0 1080 2406]`. A frame this table cannot prove to be a band must not become one: the
 * tap guard measures a published frame directly, so a display-spanning frame would mark every
 * on-screen point keyboard-covered.
 */
const DISPLAY_SPANNING_RECT_SHARE = 0.9;

/**
 * Reads the keyboard band out of a WindowManagerService window table. The table lists the
 * panel on every device that shows a software keyboard; a device whose table omits it, or
 * whose panel row carries no readable rect, answers `unmeasurable` rather than a guess. The
 * z-order column is the visibility signal (negative while hidden); the rect is trusted as a
 * band only when the table proves it smaller than the display, which current builds do not —
 * a display-spanning rect publishes `visibility-only` and leaves the band to the guard's
 * tree derivation.
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
  if (!visible?.rect) return { kind: 'visibility-only', visible: false };
  const display = displayRectFromWindowDump(raw);
  if (!display || rectAreaShare(visible.rect, display) >= DISPLAY_SPANNING_RECT_SHARE) {
    return { kind: 'visibility-only', visible: true };
  }
  return { kind: 'visible', frame: visible.rect };
}

/** The largest positive rect in the table, which the display-sized system windows hold. */
function displayRectFromWindowDump(raw: string): Rect | undefined {
  let display: Rect | undefined;
  let largestArea = 0;
  for (const line of raw.split('\n')) {
    const rect = rectFromWindowRow(line);
    if (!rect || rect.width <= 0 || rect.height <= 0) continue;
    const area = rect.width * rect.height;
    if (area > largestArea) {
      display = rect;
      largestArea = area;
    }
  }
  return display;
}

function rectAreaShare(rect: Rect, display: Rect): number {
  if (display.width <= 0 || display.height <= 0) return 0;
  return (rect.width * rect.height) / (display.width * display.height);
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
