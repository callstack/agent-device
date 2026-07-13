import { AppError } from '../../kernel/errors.ts';
import type { Rect } from '../../kernel/snapshot.ts';

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
