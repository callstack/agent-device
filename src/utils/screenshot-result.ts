import type { ScreenshotOverlayRef } from './snapshot.ts';
import { isRecord, readOptionalString, readPoint, readRect } from './parsing.ts';

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
  const ref = readOptionalString(value, 'ref');
  const geometry = readScreenshotOverlayGeometry(value);
  if (!ref || !geometry) return undefined;
  return {
    ref,
    ...readScreenshotOverlayLabel(value),
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
  const label = readOptionalString(record, 'label');
  return label ? { label } : {};
}
