import { AppError } from '@agent-device/kernel/errors';
import type { Rect } from '@agent-device/kernel/snapshot';

/**
 * What the helper reports about the surface a gesture may target: the application window, and the
 * input method window's share of the screen when a keyboard is on screen.
 *
 * The keyboard arrives as absolute screen pixels — the same space as the application window's
 * `getBoundsInScreen()` — and is never converted into another platform's coordinate space.
 */
export type AndroidGestureViewportReading = Readonly<{
  viewport: Rect;
  /**
   * Absent when no input method window is on screen, or when the installed helper predates the
   * keyboard read. Either way there is nothing to avoid; absence is not evidence of occlusion.
   */
  keyboard?: Rect;
}>;

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
