import type { Rect } from '@agent-device/kernel/snapshot';
import { rectContains } from '@agent-device/kernel/rect';

export { rectContains };

export function hasPositiveRect(rect: Rect | undefined): rect is Rect {
  return Boolean(rect && rect.width > 0 && rect.height > 0);
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

export function rectArea(rect: Rect): number {
  return rect.width * rect.height;
}
