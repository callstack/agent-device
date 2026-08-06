import type { SnapshotCaptureAnnotations } from '@agent-device/contracts/capture';

/**
 * The agent-facing wording for a proven no-effect gesture. Names the exact
 * gesture, admits the honest ambiguity (at-edge is a legitimate no-op the
 * platform cannot distinguish), and hands over the one escape hatch that
 * moved a stuck list when synthesized scrolls did not (#1600, element-18:
 * raw `swipe` worked where scroll/fling/pan all silently no-opped).
 */
export function formatGestureNoEffectWarning(action: string, positionals: string[]): string {
  const gesture = [action, ...positionals.filter((value) => !/^[\d.-]+$/.test(value))]
    .join(' ')
    .trim();
  return (
    `${gesture} produced no visible change: the tree still matches its pre-gesture state. ` +
    'Either the container is already at its edge, or it ignores synthesized scrolls — ' +
    'a raw drag moves such lists: swipe x1 y1 x2 y2 (start inside the list).'
  );
}

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
