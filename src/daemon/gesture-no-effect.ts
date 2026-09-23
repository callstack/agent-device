import type { SnapshotCaptureAnnotations } from '@agent-device/contracts/capture';
import { formatGestureNoEffectWarning } from '@agent-device/capture-kit/post-gesture-stability';

/**
 * #1600: a proven no-effect gesture must reach the agent inside the very
 * response it reads next, not only the diagnostics stream. Warnings ride the
 * existing annotations channel so every renderer that already prints capture
 * warnings picks this up with no new plumbing.
 */
export function withGestureNoEffectWarning(
  annotations: SnapshotCaptureAnnotations,
  gestureNoEffect: { action: string; positionals: string[] } | undefined,
): SnapshotCaptureAnnotations {
  if (!gestureNoEffect) return annotations;
  return {
    ...annotations,
    warnings: [
      ...(annotations.warnings ?? []),
      formatGestureNoEffectWarning(gestureNoEffect.action, gestureNoEffect.positionals),
    ],
  };
}
