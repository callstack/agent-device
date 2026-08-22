import type { SessionAction } from '@agent-device/contracts/session';
import { DEVICE_ROTATIONS } from '@agent-device/contracts/device';
import { BACK_MODES } from '@agent-device/contracts/back-mode';
import { TV_REMOTE_BUTTONS } from '@agent-device/contracts/tv-remote';
import { PUBLIC_COMMANDS } from '../command-catalog.ts';
import { isKeyboardAction } from '../utils/keyboard-actions.ts';
import {
  compactSessionEventDetails as compactDetails,
  readSessionEventBoolean as readBoolean,
  readBoundedSessionEventString,
  readSessionEventEnum as readEnum,
  readRequestedScreenshotFileName,
  readSessionEventFileName,
  readSessionEventNumber,
  readSessionEventString,
} from './session-event-request.ts';
import type { DaemonRequest } from './types.ts';

const SCROLL_DIRECTIONS = ['up', 'down', 'left', 'right'] as const;
const SCROLL_EDGES = ['top', 'bottom'] as const;

export function buildInstallActionSummary(action: SessionAction): string {
  const verb = action.command === PUBLIC_COMMANDS.reinstall ? 'Reinstalled' : 'Installed';
  return `${verb} ${readInstalledAppLabel(action.result ?? {}) ?? 'app'}`;
}

export function buildStructuredActionSummary(action: SessionAction): string | undefined {
  const result = action.result ?? {};
  switch (action.command) {
    case PUBLIC_COMMANDS.scroll:
      return buildScrollActionSummary(result);
    case PUBLIC_COMMANDS.screenshot:
      return buildScreenshotActionSummary(result);
    case PUBLIC_COMMANDS.home:
      return 'Went home';
    case PUBLIC_COMMANDS.back:
      return buildBackActionSummary(result);
    case PUBLIC_COMMANDS.appSwitcher:
      return 'Opened app switcher';
    case PUBLIC_COMMANDS.orientation:
      return buildOrientationActionSummary(result);
    case PUBLIC_COMMANDS.viewport:
      return buildViewportActionSummary(result);
    case PUBLIC_COMMANDS.clipboard:
      return buildClipboardActionSummary(result);
    case PUBLIC_COMMANDS.keyboard:
      return buildKeyboardActionSummary(result);
    case PUBLIC_COMMANDS.tvRemote:
      return buildTvRemoteActionSummary(result);
    case PUBLIC_COMMANDS.gesture:
      return buildGestureActionSummary(result);
    case PUBLIC_COMMANDS.swipe:
      return buildSwipeActionSummary(result);
    case PUBLIC_COMMANDS.trace:
      return buildArtifactActionSummary('trace', action);
    case PUBLIC_COMMANDS.record:
      return buildArtifactActionSummary('recording', action);
    default:
      return undefined;
  }
}

export function buildStructuredActionDetails(action: SessionAction): Record<string, unknown> {
  const result = action.result ?? {};
  switch (action.command) {
    case PUBLIC_COMMANDS.scroll:
      return compactDetails({
        direction: readEnum(result.direction, SCROLL_DIRECTIONS),
        edge: readEnum(result.edge, SCROLL_EDGES),
        passes: readSessionEventNumber(result.passes),
        amount: readSessionEventNumber(result.amount),
        pixels: readSessionEventNumber(result.pixels),
        durationMs: readSessionEventNumber(result.durationMs),
        x1: readSessionEventNumber(result.x1),
        y1: readSessionEventNumber(result.y1),
        x2: readSessionEventNumber(result.x2),
        y2: readSessionEventNumber(result.y2),
      });
    case PUBLIC_COMMANDS.screenshot:
      return compactDetails({
        requestedFileName: readScreenshotFileName(result),
      });
    case PUBLIC_COMMANDS.back:
      return compactDetails({ mode: readEnum(result.mode, BACK_MODES) });
    case PUBLIC_COMMANDS.orientation:
      return compactDetails({ orientation: readEnum(result.orientation, DEVICE_ROTATIONS) });
    case PUBLIC_COMMANDS.viewport:
      return compactDetails({
        width: readSessionEventNumber(result.width),
        height: readSessionEventNumber(result.height),
      });
    case PUBLIC_COMMANDS.clipboard:
      return compactDetails({ action: readEnum(result.action, ['read', 'write']) });
    case PUBLIC_COMMANDS.keyboard:
      return buildKeyboardActionDetails(result);
    case PUBLIC_COMMANDS.tvRemote:
      return compactDetails({
        button: readEnum(result.button, TV_REMOTE_BUTTONS),
        durationMs: readSessionEventNumber(result.durationMs),
      });
    case PUBLIC_COMMANDS.gesture:
    case PUBLIC_COMMANDS.swipe:
      return buildGestureActionDetails(result);
    case PUBLIC_COMMANDS.trace:
    case PUBLIC_COMMANDS.record:
      return compactDetails({
        action: readEnum(result.action, ['start', 'stop']),
        fileName: readArtifactFileName(action),
        showTouches: readBoolean(result.showTouches),
      });
    default:
      return {};
  }
}

export function buildActionEventResult(
  req: Pick<DaemonRequest, 'command' | 'meta'>,
  result: Record<string, unknown>,
): Record<string, unknown> {
  if (req.command !== PUBLIC_COMMANDS.screenshot) return result;
  const requestedFileName = readRequestedScreenshotFileName(req, result);
  return requestedFileName ? { ...result, requestedFileName } : result;
}

function readInstalledAppLabel(result: Record<string, unknown>): string | undefined {
  const appName = readBoundedSessionEventString(result.appName);
  const appId = readFirstString(result, ['bundleId', 'packageName', 'appBundleId', 'launchTarget']);
  if (appName && appId && appName !== appId) return `${appName} (${appId})`;
  return appName ?? appId ?? readActionAppFallback(result);
}

function readActionAppFallback(result: Record<string, unknown>): string | undefined {
  const app = readBoundedSessionEventString(result.app);
  return app && !app.includes('/') && !app.includes('\\') ? app : undefined;
}

function buildScrollActionSummary(result: Record<string, unknown>): string {
  const direction = readEnum(result.direction, SCROLL_DIRECTIONS);
  const edge = readEnum(result.edge, SCROLL_EDGES);
  const passes = readSessionEventNumber(result.passes);
  if (edge) return buildScrollEdgeSummary(edge, passes);
  if (!direction) return 'Scrolled';
  return buildDirectionalScrollSummary(direction, result);
}

function buildScrollEdgeSummary(edge: string, passes: number | undefined): string {
  if (passes === 0) return `Already at ${edge}`;
  if (passes === undefined) return `Scrolled to ${edge}`;
  return `Scrolled to ${edge} in ${passes} ${passes === 1 ? 'pass' : 'passes'}`;
}

function buildDirectionalScrollSummary(direction: string, result: Record<string, unknown>): string {
  const pixels = readSessionEventNumber(result.pixels);
  if (pixels !== undefined) return `Scrolled ${direction} by ${pixels}px`;
  const amount = readSessionEventNumber(result.amount);
  return amount === undefined ? `Scrolled ${direction}` : `Scrolled ${direction} by ${amount}`;
}

function buildScreenshotActionSummary(result: Record<string, unknown>): string {
  const fileName = readScreenshotFileName(result);
  return fileName ? `Captured screenshot ${fileName}` : 'Captured screenshot';
}

function readScreenshotFileName(result: Record<string, unknown>): string | undefined {
  return (
    readSessionEventFileName(result.requestedFileName) ?? readSessionEventFileName(result.path)
  );
}

function buildBackActionSummary(result: Record<string, unknown>): string {
  const mode = readEnum(result.mode, BACK_MODES);
  return mode === 'system' ? 'Went back using system navigation' : 'Went back';
}

function buildOrientationActionSummary(result: Record<string, unknown>): string {
  const orientation = readEnum(result.orientation, DEVICE_ROTATIONS);
  return orientation ? `Rotated to ${orientation}` : 'Changed orientation';
}

function buildViewportActionSummary(result: Record<string, unknown>): string {
  const width = readSessionEventNumber(result.width);
  const height = readSessionEventNumber(result.height);
  return width !== undefined && height !== undefined
    ? `Set viewport to ${width}×${height}`
    : 'Changed viewport';
}

function buildClipboardActionSummary(result: Record<string, unknown>): string {
  const action = readEnum(result.action, ['read', 'write']);
  if (action === 'read') return 'Read clipboard';
  if (action === 'write') return 'Updated clipboard';
  return 'Used clipboard';
}

function buildKeyboardActionSummary(result: Record<string, unknown>): string {
  const action = readSessionEventString(result.action);
  if (!action || !isKeyboardAction(action)) return 'Used keyboard';
  if (action === 'dismiss') return buildKeyboardDismissSummary(result);
  if (action === 'enter' || action === 'return') return 'Pressed keyboard return';
  const visible = readBoolean(result.visible);
  if (visible === undefined) return 'Inspected keyboard';
  return visible ? 'Keyboard is visible' : 'Keyboard is hidden';
}

function buildKeyboardDismissSummary(result: Record<string, unknown>): string {
  if (readBoolean(result.dismissed) === false) return 'Keyboard was already hidden';
  return 'Dismissed keyboard';
}

function buildKeyboardActionDetails(result: Record<string, unknown>): Record<string, unknown> {
  const action = readSessionEventString(result.action);
  return compactDetails({
    action: action && isKeyboardAction(action) ? action : undefined,
    platform: readEnum(result.platform, ['ios', 'android']),
    visible: readBoolean(result.visible),
    wasVisible: readBoolean(result.wasVisible),
    dismissed: readBoolean(result.dismissed),
    attempts: readSessionEventNumber(result.attempts),
    mechanism: readEnum(result.mechanism, ['dismissKey']),
  });
}

function buildTvRemoteActionSummary(result: Record<string, unknown>): string {
  const button = readEnum(result.button, TV_REMOTE_BUTTONS);
  return button ? `Pressed TV remote ${button}` : 'Used TV remote';
}

function buildGestureActionSummary(result: Record<string, unknown>): string {
  const kind = readEnum(result.kind, ['fling', 'pan', 'pinch', 'rotate', 'transform']);
  return kind ? `Ran ${kind} gesture` : 'Ran gesture';
}

function buildSwipeActionSummary(result: Record<string, unknown>): string {
  const count = readSessionEventNumber(result.count);
  return count !== undefined && count > 1 ? `Swiped ${count} times` : 'Swiped';
}

function buildGestureActionDetails(result: Record<string, unknown>): Record<string, unknown> {
  return compactDetails({
    kind: readEnum(result.kind, ['fling', 'pan', 'pinch', 'rotate', 'transform']),
    durationMs: readSessionEventNumber(result.durationMs),
    pointerCount: readSessionEventNumber(result.pointerCount),
    x1: readSessionEventNumber(result.x1),
    y1: readSessionEventNumber(result.y1),
    x2: readSessionEventNumber(result.x2),
    y2: readSessionEventNumber(result.y2),
    count: readSessionEventNumber(result.count),
    pauseMs: readSessionEventNumber(result.pauseMs),
    pattern: readEnum(result.pattern, ['one-way', 'ping-pong']),
    scale: readSessionEventNumber(result.scale),
  });
}

function buildArtifactActionSummary(kind: 'trace' | 'recording', action: SessionAction): string {
  const actionName = readEnum(action.result?.action, ['start', 'stop']);
  const verb = buildArtifactVerb(kind, actionName);
  const fileName = readArtifactFileName(action);
  return fileName ? `${verb} ${fileName}` : verb;
}

function buildArtifactVerb(
  kind: 'trace' | 'recording',
  action: 'start' | 'stop' | undefined,
): string {
  if (action === 'start') return kind === 'trace' ? 'Started trace' : 'Started recording';
  if (action === 'stop') return kind === 'trace' ? 'Stopped trace' : 'Stopped recording';
  return kind === 'trace' ? 'Updated trace' : 'Updated recording';
}

function readArtifactFileName(action: SessionAction): string | undefined {
  const result = action.result ?? {};
  return (
    readSessionEventFileName(result.requestedFileName) ??
    readSessionEventFileName(result.outPath) ??
    readSessionEventFileName(result.path) ??
    readSessionEventFileName(action.positionals[1])
  );
}

function readFirstString(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const text = readBoundedSessionEventString(value[key]);
    if (text) return text;
  }
  return undefined;
}
