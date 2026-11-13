import {
  SCREENSHOT_BURST_LIMITS,
  type ScreenshotBurstFrame,
  type ScreenshotResultData,
} from '@agent-device/contracts/capture';
import type { CaptureScreenshotResult } from '@agent-device/contracts/client';
import { isDeviceRotation } from '@agent-device/contracts/device';
import { isRecord, parsePoint, parseRect, readRequiredString } from '@agent-device/kernel/record';
import { readResponseWarnings } from '@agent-device/kernel/success-text';
import type { ScreenshotOverlayRef } from '@agent-device/kernel/snapshot';

export function pickScreenshotResultData(value: ScreenshotResultData): ScreenshotResultData {
  const frames = readScreenshotBurstFrames(value.frames);
  return {
    ...(typeof value.path === 'string' ? { path: value.path } : {}),
    ...(typeof value.width === 'number' ? { width: value.width } : {}),
    ...(typeof value.height === 'number' ? { height: value.height } : {}),
    ...(typeof value.logicalWidth === 'number' ? { logicalWidth: value.logicalWidth } : {}),
    ...(typeof value.logicalHeight === 'number' ? { logicalHeight: value.logicalHeight } : {}),
    ...(typeof value.pixelDensity === 'number' ? { pixelDensity: value.pixelDensity } : {}),
    ...(isDeviceRotation(value.displayRotation) ? { displayRotation: value.displayRotation } : {}),
    ...(frames ? { frames } : {}),
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
    ...(screenshot?.displayRotation ? { displayRotation: screenshot.displayRotation } : {}),
    ...(screenshot?.frames ? { frames: screenshot.frames } : {}),
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
  const warnings = readScreenshotWarnings(value);
  return pickScreenshotResultData({
    path: readStringField(value, 'path'),
    width: readNumberField(value, 'width'),
    height: readNumberField(value, 'height'),
    logicalWidth: readNumberField(value, 'logicalWidth'),
    logicalHeight: readNumberField(value, 'logicalHeight'),
    pixelDensity: readNumberField(value, 'pixelDensity'),
    displayRotation: isDeviceRotation(value.displayRotation) ? value.displayRotation : undefined,
    frames: readScreenshotBurstFrames(value.frames),
    overlayRefs: readScreenshotOverlayRefs(value.overlayRefs),
    ...(warnings !== undefined ? { warnings } : {}),
  });
}

/**
 * The burst frames a payload may report: one plan admits at most `maxCount` frames, so a longer
 * array is truncated, and a frame without a path and a wall clock is not evidence of a capture.
 */
function readScreenshotBurstFrames(value: unknown): ScreenshotBurstFrame[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const frames = value
    .slice(0, SCREENSHOT_BURST_LIMITS.maxCount)
    .flatMap((frame) => readScreenshotBurstFrame(frame) ?? []);
  return frames.length > 0 ? frames : undefined;
}

function readScreenshotBurstFrame(frame: unknown): ScreenshotBurstFrame | undefined {
  if (!isRecord(frame)) return undefined;
  if (typeof frame.path !== 'string' || frame.path.length === 0) return undefined;
  if (typeof frame.capturedAtMs !== 'number' || !Number.isFinite(frame.capturedAtMs)) {
    return undefined;
  }
  return {
    path: frame.path,
    capturedAtMs: frame.capturedAtMs,
    ...(isDeviceRotation(frame.displayRotation) ? { displayRotation: frame.displayRotation } : {}),
  };
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

function readScreenshotWarnings(data: Record<string, unknown>): string[] | undefined {
  // An absent or non-array field is "no warnings channel on this result";
  // the field contract itself is the shared parser's.
  if (!Array.isArray(data.warnings)) return undefined;
  return readResponseWarnings(data).filter((warning) => warning.length > 0);
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
