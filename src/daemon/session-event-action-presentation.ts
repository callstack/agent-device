import { PUBLIC_COMMANDS } from '../command-catalog.ts';
import type { DaemonRequest, SessionAction } from './types.ts';
import {
  readRequestedScreenshotFileName,
  readSessionEventNumber,
  readSessionEventString,
} from './session-event-request.ts';

export function buildInstallActionSummary(action: SessionAction): string {
  const verb = action.command === PUBLIC_COMMANDS.reinstall ? 'Reinstalled' : 'Installed';
  return `${verb} ${readInstalledAppLabel(action.result ?? {}) ?? 'app'}`;
}

export function buildStructuredActionSummary(action: SessionAction): string | undefined {
  if (action.command === PUBLIC_COMMANDS.scroll) {
    return buildScrollActionSummary(action.result ?? {});
  }
  if (action.command === PUBLIC_COMMANDS.screenshot) {
    return buildScreenshotActionSummary(action.result ?? {});
  }
  return undefined;
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
  const appName = readSessionEventString(result.appName);
  const appId = readFirstString(result, ['bundleId', 'packageName', 'appBundleId', 'launchTarget']);
  if (appName && appId && appName !== appId) return `${appName} (${appId})`;
  return appName ?? appId ?? readActionAppFallback(result);
}

function readActionAppFallback(result: Record<string, unknown>): string | undefined {
  const app = readSessionEventString(result.app);
  return app && !app.includes('/') && !app.includes('\\') ? app : undefined;
}

function buildScrollActionSummary(result: Record<string, unknown>): string {
  const direction = readSessionEventString(result.direction);
  const edge = readSessionEventString(result.edge);
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
  const outputPath =
    readSessionEventString(result.requestedFileName) ?? readSessionEventString(result.path);
  return outputPath?.split(/[\\/]/).at(-1);
}

function readFirstString(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const text = readSessionEventString(value[key]);
    if (text) return text;
  }
  return undefined;
}
