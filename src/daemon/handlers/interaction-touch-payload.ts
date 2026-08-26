import type { GestureReferenceFrame } from '@agent-device/contracts/scroll-gesture';
import { successText } from '../../utils/success-text.ts';

/**
 * What a built touch payload looks like: the field merge (backend data, point,
 * reference frame, extras) and the one success message each target shape reads.
 * Identity and disclosure composition stay in interaction-touch-response.ts.
 */

export function buildTouchPayload(params: {
  data: Record<string, unknown> | undefined;
  fallbackX?: number;
  fallbackY?: number;
  referenceFrame?: GestureReferenceFrame;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  const { data, fallbackX, fallbackY, referenceFrame, extra } = params;
  const message =
    buildTouchMessage(extra, fallbackX, fallbackY) ??
    (typeof data?.message === 'string' ? data.message : undefined);
  return stripUndefinedFields({
    ...(data ?? {}),
    ...(fallbackX === undefined || fallbackY === undefined ? {} : { x: fallbackX, y: fallbackY }),
    ...(referenceFrame ?? {}),
    ...(extra ?? {}),
    ...successText(message),
  });
}

function stripUndefinedFields(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
}

function buildTouchMessage(
  extra: Record<string, unknown> | undefined,
  x: number | undefined,
  y: number | undefined,
): string | undefined {
  const fillText = readString(extra, 'text');
  if (fillText !== undefined) return `Filled ${Array.from(fillText).length} chars`;

  const pointSuffix = buildPointSuffix(x, y);
  const label = buildTouchTargetLabel(extra);
  if (label) return buildTouchTargetMessage(label, extra ?? {}, pointSuffix);
  if (!pointSuffix) return undefined;

  return buildPointTouchMessage(extra, pointSuffix);
}

function readString(data: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = data?.[key];
  return typeof value === 'string' ? value : undefined;
}

function buildPointSuffix(x: number | undefined, y: number | undefined): string {
  return x === undefined || y === undefined ? '' : ` (${x}, ${y})`;
}

function buildTouchTargetLabel(extra: Record<string, unknown> | undefined): string | undefined {
  const ref = readString(extra, 'ref');
  return ref === undefined ? readString(extra, 'selector') : `@${ref}`;
}

function buildPointTouchMessage(
  extra: Record<string, unknown> | undefined,
  pointSuffix: string,
): string {
  if (extra?.gesture === 'longpress') return `Long pressed${pointSuffix}`;
  if (extra?.gesture === 'hover') return `Hovered${pointSuffix}`;
  return `Tapped${pointSuffix}`;
}

function buildTouchTargetMessage(
  label: string,
  extra: Record<string, unknown>,
  pointSuffix: string,
): string {
  const button = typeof extra.button === 'string' ? extra.button : undefined;
  if (extra.gesture === 'longpress') {
    return `Long pressed ${label}${pointSuffix}`;
  }
  if (extra.gesture === 'hover') {
    return `Hovered ${label}${pointSuffix}`;
  }
  if (button && button !== 'primary') {
    return `Clicked ${button} ${label}${pointSuffix}`;
  }
  return `Tapped ${label}${pointSuffix}`;
}
