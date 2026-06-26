import type { ScreenshotOverlayRef } from './snapshot.ts';
import { readPoint, readRect } from './parsing.ts';

export type ScreenshotResultData = {
  path?: string;
  overlayRefs?: ScreenshotOverlayRef[];
};

export function readScreenshotResultData(value: unknown): ScreenshotResultData | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const path = typeof record.path === 'string' ? record.path : undefined;
  const overlayRefs = Array.isArray(record.overlayRefs)
    ? record.overlayRefs.flatMap((entry) => {
        const overlayRef = readScreenshotOverlayRef(entry);
        return overlayRef ? [overlayRef] : [];
      })
    : undefined;
  return {
    ...(path ? { path } : {}),
    ...(overlayRefs ? { overlayRefs } : {}),
  };
}

function readScreenshotOverlayRef(value: unknown): ScreenshotOverlayRef | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const ref = typeof record.ref === 'string' && record.ref.length > 0 ? record.ref : undefined;
  const rect = readRect(record, 'rect');
  const overlayRect = readRect(record, 'overlayRect');
  const center = readPoint(record, 'center');
  if (!ref || !rect || !overlayRect || !center) return undefined;
  return {
    ref,
    ...(typeof record.label === 'string' && record.label.length > 0 ? { label: record.label } : {}),
    rect,
    overlayRect,
    center,
  };
}
