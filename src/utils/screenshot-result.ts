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
    ? value.overlayRefs.flatMap((entry) => {
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
  if (!isRecord(value)) return undefined;
  const ref = typeof value.ref === 'string' && value.ref.length > 0 ? value.ref : undefined;
  const rect = readRect(value, 'rect');
  const overlayRect = readRect(value, 'overlayRect');
  const center = readPoint(value, 'center');
  if (!ref || !rect || !overlayRect || !center) return undefined;
  return {
    ref,
    ...(typeof value.label === 'string' && value.label.length > 0 ? { label: value.label } : {}),
    rect,
    overlayRect,
    center,
  };
}
