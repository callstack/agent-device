import type { ScreenshotOverlayRef } from '../kernel/snapshot.ts';
import { isRecord, parsePoint, parseRect } from './parsing.ts';

export type ScreenshotResultData = {
  path?: string;
  width?: number;
  height?: number;
  logicalWidth?: number;
  logicalHeight?: number;
  pixelDensity?: number;
  overlayRefs?: ScreenshotOverlayRef[];
};

export function pickScreenshotResultData(value: ScreenshotResultData): ScreenshotResultData {
  return {
    ...(typeof value.path === 'string' ? { path: value.path } : {}),
    ...(typeof value.width === 'number' ? { width: value.width } : {}),
    ...(typeof value.height === 'number' ? { height: value.height } : {}),
    ...(typeof value.logicalWidth === 'number' ? { logicalWidth: value.logicalWidth } : {}),
    ...(typeof value.logicalHeight === 'number' ? { logicalHeight: value.logicalHeight } : {}),
    ...(typeof value.pixelDensity === 'number' ? { pixelDensity: value.pixelDensity } : {}),
    ...(value.overlayRefs ? { overlayRefs: value.overlayRefs } : {}),
  };
}

type ScreenshotOverlayRefData = {
  ref?: unknown;
  label?: unknown;
  rect?: unknown;
  overlayRect?: unknown;
  center?: unknown;
};

export function readScreenshotResultData(value: unknown): ScreenshotResultData | undefined {
  if (!isRecord(value)) return undefined;
  const path = typeof value.path === 'string' ? value.path : undefined;
  const width = typeof value.width === 'number' ? value.width : undefined;
  const height = typeof value.height === 'number' ? value.height : undefined;
  const logicalWidth = typeof value.logicalWidth === 'number' ? value.logicalWidth : undefined;
  const logicalHeight = typeof value.logicalHeight === 'number' ? value.logicalHeight : undefined;
  const pixelDensity = typeof value.pixelDensity === 'number' ? value.pixelDensity : undefined;
  const overlayRefs = Array.isArray(value.overlayRefs)
    ? value.overlayRefs.filter(isScreenshotOverlayRefData).flatMap((entry) => {
        const overlayRef = readScreenshotOverlayRef(entry);
        return overlayRef ? [overlayRef] : [];
      })
    : undefined;
  return pickScreenshotResultData({
    path,
    width,
    height,
    logicalWidth,
    logicalHeight,
    pixelDensity,
    overlayRefs,
  });
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
