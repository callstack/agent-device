import type { DeviceInfo } from '@agent-device/kernel/device';
import { isCommandTimeoutError } from '@agent-device/host-kit/command';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';

import { IOS_APPLE_DISPLAY_PROBE_TIMEOUT_MS } from './config.ts';
import { runIosDevicectlJsonRequest } from './devicectl.ts';

export type AppleDeviceDisplay = {
  /** CoreDevice display name, which `simctl io --display` also accepts. */
  name: string;
  displayId: number;
  /**
   * Whether the panel is showing content. `active` is absent from real payloads
   * (a single-panel iPhone 17 reports only `backlightState`), so this is derived
   * from the strongest signal the payload actually carries.
   */
  power: ApplePanelPower;
  /**
   * CoreDevice's own `primary` flag. On a foldable this is the panel that stays lit
   * while the device is closed, which makes it the fallback a multi-panel capture
   * names when panel power decides nothing.
   */
  primary: boolean;
  widthPx: number;
  heightPx: number;
  pointScale: number;
  currentOrientation: string;
  /** CoreDevice `type: integrated` — a panel built into the device. */
  integrated: boolean;
};

/** Whether a panel is lit, dark, or reporting nothing decidable. */
export type ApplePanelPower = 'lit' | 'dark' | 'unknown';

/** CoreDevice `BacklightState` cases that mean the panel is lit. */
const LIT_BACKLIGHT_STATES = new Set(['activeOn', 'inactiveOn', 'activeDimmed']);
const DARK_BACKLIGHT_STATES = new Set(['off']);

export type AppleDisplayInventory = {
  displays: AppleDeviceDisplay[];
  /**
   * True when the device presents more than one integrated panel, i.e. a
   * foldable such as iPhone Duo. Single-panel devices keep their historic
   * single-screen behavior and never route through a display selector.
   */
  multiScreen: boolean;
  activeDisplay?: AppleDeviceDisplay;
  /**
   * True on a multi-panel device whose lit panel could not be decided, so the
   * capture fell back to the `primary` panel. The capture is still named — never
   * implicit — but the caller must not present it as a settled panel choice.
   */
  ambiguous: boolean;
  /**
   * True when CoreDevice could not be asked, or answered without a usable
   * display list. Callers must then keep the pre-display-inventory capture path
   * rather than fail, because an unsupported toolchain is not a capture failure.
   */
  unresolved: boolean;
};

type CoreDeviceDisplayEntry = {
  name?: unknown;
  displayId?: unknown;
  active?: unknown;
  backlightState?: unknown;
  primary?: unknown;
  nativeSize?: unknown[];
  pointScale?: unknown;
  currentOrientation?: unknown;
  type?: unknown;
};

type CoreDeviceDisplayPayload = {
  result?: {
    displays?: unknown;
  };
};

const DISPLAYS_UNSUPPORTED_HINT =
  "This Xcode/CoreDevice toolchain does not report 'devicectl device info displays'. Update Xcode to a version that ships the display-information feature before targeting multi-display Apple devices.";

/**
 * Reads the CoreDevice display table for one Apple device.
 *
 * Deliberately uncached: which panel is lit is exactly what changes when an
 * operator folds or opens the device, and a cached answer would resume capturing
 * the dark panel. The probe costs ~0.2s against a ~5s simulator screenshot.
 *
 * A failure to ask is reported as an unresolved inventory instead of an error:
 * every caller has a correct pre-inventory path, and a missing host feature must
 * not fail the user's capture.
 */
async function queryAppleDisplayInventory(
  device: DeviceInfo,
  options: { timeoutMs?: number; signal?: AbortSignal },
): Promise<AppleDisplayInventory> {
  try {
    const outcome = await runIosDevicectlJsonRequest({
      jsonPrefix: 'agent-device-apple-displays',
      args: ['devicectl', 'device', 'info', 'displays', '--device', device.id],
      timeoutMs: options.timeoutMs ?? IOS_APPLE_DISPLAY_PROBE_TIMEOUT_MS,
      signal: options.signal,
    });
    if (!outcome.ok) {
      emitUnresolvedDiagnostic(
        device,
        outcome.reason,
        outcome.result ? outcome.result.stderr.trim() : (outcome.cause ?? ''),
      );
      return unresolvedInventory();
    }
    const displays = parseCoreDeviceDisplays(outcome.payload);
    if (displays.length === 0) {
      emitUnresolvedDiagnostic(device, 'empty-display-list', '');
      return unresolvedInventory();
    }
    return buildInventory(displays);
  } catch (error) {
    // exec classifies its own kills, so a probe that never answered is told apart
    // from a toolchain that refused the subcommand.
    emitUnresolvedDiagnostic(
      device,
      isCommandTimeoutError(error) ? 'probe-timed-out' : 'probe-failed',
      error instanceof Error ? error.message : String(error),
    );
    return unresolvedInventory();
  }
}

function emitUnresolvedDiagnostic(device: DeviceInfo, reason: string, detail: string): void {
  emitDiagnostic({
    level: 'warn',
    phase: 'apple_display_inventory_unresolved',
    data: {
      platform: device.platform,
      deviceId: device.id,
      reason,
      ...(detail ? { detail } : {}),
      // Only a refusal to answer says the toolchain lacks the feature; a timeout or a
      // canceled request says nothing about it.
      ...(reason === 'command-failed' || reason === 'unreadable-json'
        ? { hint: DISPLAYS_UNSUPPORTED_HINT }
        : {}),
    },
  });
}

function unresolvedInventory(): AppleDisplayInventory {
  return { displays: [], multiScreen: false, ambiguous: false, unresolved: true };
}

export function parseCoreDeviceDisplays(payload: unknown): AppleDeviceDisplay[] {
  const entries = (payload as CoreDeviceDisplayPayload | null | undefined)?.result?.displays;
  if (!Array.isArray(entries)) return [];

  const displays: AppleDeviceDisplay[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const display = parseCoreDeviceDisplayEntry(entry as CoreDeviceDisplayEntry);
    if (display) displays.push(display);
  }
  return displays;
}

function parseCoreDeviceDisplayEntry(
  entry: CoreDeviceDisplayEntry,
): AppleDeviceDisplay | undefined {
  const geometry = readDisplayGeometry(entry);
  if (!geometry) return undefined;
  return {
    ...geometry,
    power: readPanelPower(entry.backlightState, entry.active),
    primary: entry.primary === true,
    currentOrientation:
      typeof entry.currentOrientation === 'string' ? entry.currentOrientation : 'unknown',
    integrated: isIntegratedDisplayType(entry.type),
  };
}

/**
 * The identity and pixel geometry a capture cannot proceed without: `name` is the
 * string `simctl io --display` expects, and the size plus scale are what convert
 * captured pixels back to the logical points that interaction coordinates use.
 */
function readDisplayGeometry(entry: CoreDeviceDisplayEntry): AppleDisplayGeometry | undefined {
  const name = readDisplayName(entry.name);
  const displayId = readInteger(entry.displayId);
  const pointScale = readPositiveNumber(entry.pointScale);
  const size = readNativeSize(entry.nativeSize);
  if (!name || displayId === undefined || pointScale === undefined || !size) return undefined;
  return { name, displayId, pointScale, widthPx: size.widthPx, heightPx: size.heightPx };
}

type AppleDisplayGeometry = {
  name: string;
  displayId: number;
  pointScale: number;
  widthPx: number;
  heightPx: number;
};

function readDisplayName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.trim();
  return name.length > 0 ? name : undefined;
}

function readNativeSize(value: unknown): { widthPx: number; heightPx: number } | undefined {
  if (!Array.isArray(value)) return undefined;
  const widthPx = readPositiveNumber(value[0]);
  const heightPx = readPositiveNumber(value[1]);
  if (widthPx === undefined || heightPx === undefined) return undefined;
  return { widthPx, heightPx };
}

function readInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Decides whether a panel is lit, preferring the backlight state because
 * `active` is genuinely absent from some CoreDevice payloads. An unrecognized
 * backlight case is `unknown` rather than `dark`: guessing dark would aim a
 * capture at a panel that may be showing nothing.
 */
export function readPanelPower(backlightState: unknown, active: unknown): ApplePanelPower {
  if (typeof backlightState === 'string') {
    if (LIT_BACKLIGHT_STATES.has(backlightState)) return 'lit';
    if (DARK_BACKLIGHT_STATES.has(backlightState)) return 'dark';
    return 'unknown';
  }
  if (active === true) return 'lit';
  if (active === false) return 'dark';
  return 'unknown';
}

/** CoreDevice encodes the display-type union as a single-case object, e.g. `{ integrated: {} }`. */
function isIntegratedDisplayType(value: unknown): boolean {
  return typeof value === 'object' && value !== null && Object.hasOwn(value, 'integrated');
}

export function buildInventory(displays: AppleDeviceDisplay[]): AppleDisplayInventory {
  // Only built-in panels make a device a foldable. An attached external display
  // on an iPad is not a second panel and must not turn the device into a
  // multi-screen capture target.
  const panels = displays.filter((display) => display.integrated);
  if (panels.length < 2) {
    return { displays, multiScreen: false, ambiguous: false, unresolved: false };
  }

  warnWhenPrimaryPanelIsNotTheSmallest(panels);
  const litPanels = panels.filter((display) => display.power === 'lit');
  const primaryPanel = panels.find((display) => display.primary);
  const decided = litPanels.length === 1;
  // A multi-panel device must never emit a display-less capture: simctl's implicit
  // choice is the highest screen ID, which is exactly how a foldable capture comes
  // back all black and exits 0. When panel power is ambiguous the primary panel is
  // named explicitly and the ambiguity is reported, not hidden.
  const captureDisplay = decided ? litPanels[0]! : (primaryPanel ?? litPanels[0] ?? panels[0]!);
  const ambiguous = !decided || primaryPanel === undefined;
  if (ambiguous) {
    emitDiagnostic({
      level: 'warn',
      phase: 'apple_display_capture_ambiguous',
      data: {
        reason: primaryPanel === undefined ? 'no-primary-panel' : 'lit-panel-count',
        litPanelCount: litPanels.length,
        capturedDisplay: captureDisplay.name,
        hint: 'Panel power did not identify exactly one lit panel, so the capture names the primary panel without claiming to know which panel the device is showing. Read the device pose from the app under test with UIHinge.status.',
      },
    });
  }
  return {
    displays: panels,
    multiScreen: true,
    activeDisplay: captureDisplay,
    ambiguous,
    unresolved: false,
  };
}

/**
 * Sanity-checks the panel geometry against a foldable's shape.
 *
 * CoreDevice marks the panel that stays lit while the device is closed as
 * `primary`, and that panel is the smaller one, because a foldable's inner surface
 * encloses the outer one. A payload that inverts this still gets captured by
 * `primary` — CoreDevice's flag is the authority — but the inversion is reported,
 * because it means the device type contradicts the model this code runs on.
 */
function warnWhenPrimaryPanelIsNotTheSmallest(panels: AppleDeviceDisplay[]): void {
  const primary = panels.find((display) => display.primary);
  if (!primary) return;
  const areaOf = (display: AppleDeviceDisplay) => display.widthPx * display.heightPx;
  const widest = panels
    .filter((display) => display !== primary)
    .reduce((largest, display) => (areaOf(display) > areaOf(largest) ? display : largest));
  if (areaOf(primary) < areaOf(widest)) return;
  emitDiagnostic({
    level: 'warn',
    phase: 'apple_display_primary_geometry_conflict',
    data: {
      primaryDisplay: primary.name,
      largestDisplay: widest.name,
      hint: 'CoreDevice reported the primary panel as at least as large as the other panel. CoreDevice `primary` still selects the capture fallback; verify the device type capabilities.',
    },
  });
}

/**
 * Resolves the display a capture must target.
 *
 * `simctl io screenshot` without `--display` silently picks the highest screen
 * ID, which on a closed foldable is the *dark* inner panel: the capture succeeds
 * and comes back black. A multi-panel device therefore always names a display
 * explicitly — even when panel power is ambiguous — and only a genuinely
 * single-panel device (or an unreadable toolchain) keeps the historic argv.
 */
export async function resolveAppleCaptureDisplay(
  device: DeviceInfo,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<AppleDeviceDisplay | undefined> {
  const inventory = await queryAppleDisplayInventory(device, options);
  if (inventory.unresolved || !inventory.multiScreen) return undefined;
  return inventory.activeDisplay;
}

/**
 * `simctl io` argv fragment naming the panel to capture. Empty for a
 * single-panel device, which keeps the historic capture argv.
 */
export function appleSimulatorDisplayArgvFragment(
  display: AppleDeviceDisplay | undefined,
): string[] {
  return display ? [`--display=${display.name}`] : [];
}
