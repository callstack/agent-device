import type { ScreenshotResultData } from '@agent-device/contracts/capture';
import type { CaptureScreenshotResult } from '@agent-device/contracts/client';
import { isRecord, parsePoint, parseRect, readRequiredString } from '@agent-device/kernel/record';
import type { ScreenshotOverlayRef } from '@agent-device/kernel/snapshot';

export function pickScreenshotResultData(value: ScreenshotResultData): ScreenshotResultData {
  return {
    ...(typeof value.path === 'string' ? { path: value.path } : {}),
    ...(typeof value.width === 'number' ? { width: value.width } : {}),
    ...(typeof value.height === 'number' ? { height: value.height } : {}),
    ...(typeof value.logicalWidth === 'number' ? { logicalWidth: value.logicalWidth } : {}),
    ...(typeof value.logicalHeight === 'number' ? { logicalHeight: value.logicalHeight } : {}),
    ...(typeof value.pixelDensity === 'number' ? { pixelDensity: value.pixelDensity } : {}),
    ...(value.overlayRefs ? { overlayRefs: value.overlayRefs } : {}),
    ...(value.warnings && value.warnings.length > 0 ? { warnings: value.warnings } : {}),
  };
}

/** The default-level daemon payload, normalized into the typed client result. */
export function normalizeScreenshotCaptureResult(
  data: Record<string, unknown>,
  session: string,
): CaptureScreenshotResult {
  const screenshot = readScreenshotResultData(data);
  return {
    path: readRequiredString(data, 'path'),
    width: screenshot?.width,
    height: screenshot?.height,
    logicalWidth: screenshot?.logicalWidth,
    logicalHeight: screenshot?.logicalHeight,
    pixelDensity: screenshot?.pixelDensity,
    overlayRefs: screenshot?.overlayRefs,
    ...(screenshot?.warnings ? { warnings: screenshot.warnings } : {}),
    identifiers: { session },
  };
}

type ScreenshotOverlayRefData = {
  ref?: unknown;
  label?: unknown;
  rect?: unknown;
  overlayRect?: unknown;
  center?: unknown;
};

function readScreenshotResultData(value: unknown): ScreenshotResultData | undefined {
  if (!isRecord(value)) return undefined;
  const warnings = readScreenshotWarnings(value.warnings);
  return pickScreenshotResultData({
    path: readStringField(value, 'path'),
    width: readNumberField(value, 'width'),
    height: readNumberField(value, 'height'),
    logicalWidth: readNumberField(value, 'logicalWidth'),
    logicalHeight: readNumberField(value, 'logicalHeight'),
    pixelDensity: readNumberField(value, 'pixelDensity'),
    overlayRefs: readScreenshotOverlayRefs(value.overlayRefs),
    ...(warnings !== undefined ? { warnings } : {}),
  });
}

function readNumberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === 'number' ? field : undefined;
}

function readStringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === 'string' ? field : undefined;
}

function readScreenshotOverlayRefs(value: unknown): ScreenshotOverlayRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(isScreenshotOverlayRefData).flatMap((entry) => {
    const overlayRef = readScreenshotOverlayRef(entry);
    return overlayRef ? [overlayRef] : [];
  });
}

function readScreenshotWarnings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function readScreenshotOverlayRef(
  record: ScreenshotOverlayRefData,
): ScreenshotOverlayRef | undefined {
  if (typeof record.ref !== 'string' || record.ref.length === 0) return undefined;
  const geometry = readScreenshotOverlayGeometry(record);
  if (!geometry) return undefined;
  return {
    ref: record.ref,
    ...readScreenshotOverlayLabel(record),
    ...geometry,
  };
}

function readScreenshotOverlayGeometry(
  record: ScreenshotOverlayRefData,
): Pick<ScreenshotOverlayRef, 'rect' | 'overlayRect' | 'center'> | undefined {
  const rect = parseRect(record.rect);
  if (!rect) return undefined;
  const overlayRect = parseRect(record.overlayRect);
  if (!overlayRect) return undefined;
  const center = parsePoint(record.center);
  return center ? { rect, overlayRect, center } : undefined;
}

function readScreenshotOverlayLabel(
  record: ScreenshotOverlayRefData,
): Pick<ScreenshotOverlayRef, 'label'> {
  return typeof record.label === 'string' && record.label.length > 0 ? { label: record.label } : {};
}

function isScreenshotOverlayRefData(value: unknown): value is ScreenshotOverlayRefData {
  return isRecord(value);
}
