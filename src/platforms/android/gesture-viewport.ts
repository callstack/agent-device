import { AppError } from '@agent-device/kernel/errors';
import type { Rect } from '@agent-device/kernel/snapshot';

export function validateAndroidGestureViewport(viewport: Rect): Rect {
  if (
    !Number.isFinite(viewport.x) ||
    !Number.isFinite(viewport.y) ||
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  )
    throw new AppError('COMMAND_FAILED', 'Android helper returned an invalid gesture viewport');
  return viewport;
}
