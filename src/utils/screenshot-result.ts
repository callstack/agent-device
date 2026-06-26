import type { ScreenshotOverlayRef } from './snapshot.ts';
import { isRecord, readPoint, readRect } from './parsing.ts';

export type ScreenshotResultData = {
  path?: string;
  overlayRefs?: ScreenshotOverlayRef[];
};

export function readScreenshotResultData(value: unknown): ScreenshotResultData | undefined {
  if (!isRecord(value)) return undefined;
  const path = typeof value.path === 'string' ? value.path : undefined;
  const overlayRefs = Array.isArray(value.overlayRefs)
    ? value.overlayRefs.filter(isRecord).flatMap((entry) => {
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
  record: Record<string, unknown>,
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
  record: Record<string, unknown>,
): Pick<ScreenshotOverlayRef, 'rect' | 'overlayRect' | 'center'> | undefined {
  const rect = readRect(record, 'rect');
  if (!rect) return undefined;
  const overlayRect = readRect(record, 'overlayRect');
  if (!overlayRect) return undefined;
  const center = readPoint(record, 'center');
  return center ? { rect, overlayRect, center } : undefined;
}

function readScreenshotOverlayLabel(
  record: Record<string, unknown>,
): Pick<ScreenshotOverlayRef, 'label'> {
  return typeof record.label === 'string' && record.label.length > 0 ? { label: record.label } : {};
}
