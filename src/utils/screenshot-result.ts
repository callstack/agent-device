import type { ScreenshotOverlayRef } from './snapshot.ts';
import { isRecord, parsePoint, parseRect } from './parsing.ts';

export type ScreenshotResultData = {
  path?: string;
  overlayRefs?: ScreenshotOverlayRef[];
};

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
  const overlayRefs = Array.isArray(value.overlayRefs)
    ? value.overlayRefs.filter(isScreenshotOverlayRefData).flatMap((entry) => {
        const overlayRef = readScreenshotOverlayRef(entry);
        return overlayRef ? [overlayRef] : [];
      })
    : undefined;
  return {
    ...(path ? { path } : {}),
    ...(overlayRefs ? { overlayRefs } : {}),
  };
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
