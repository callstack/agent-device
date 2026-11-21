import type { ReasonTable } from '@agent-device/kernel/errors';

/** Every `details.reason` the scroll family publishes. */
export const SCROLL_REASONS = {
  // A directional scroll did not move a container that still hides content.
  noProgress: { reason: 'scroll_no_progress' },
  // The on-screen keyboard leaves too little of the scroll surface to scroll.
  keyboardOccludesSurface: { reason: 'scroll_keyboard_occludes_surface' },
  // `scroll refresh` started away from the top of the content.
  refreshNotAtTop: { reason: 'scroll_refresh_not_at_top' },
  // `--max-passes` was given without `--until`.
  maxPassesRequiresUntil: { reason: 'scroll_max_passes_requires_until' },
  // `--max-passes` is not an integer inside its range.
  maxPassesInvalid: { reason: 'scroll_max_passes_invalid' },
  // `--until` used all its passes before the selector was visible.
  untilPassLimit: { reason: 'scroll_until_pass_limit' },
  // `--until` reached the end of the content before the selector was visible.
  untilEdgeReached: { reason: 'scroll_until_edge_reached' },
  // The `--until` gestures did not move the content.
  untilNoProgress: { reason: 'scroll_until_no_progress' },
  // `--until` could not read the screen between passes.
  untilCaptureUnreadable: { reason: 'scroll_until_capture_unreadable' },
  // `scroll top` or `scroll bottom` reached its pass limit before the edge.
  edgePassLimit: { reason: 'scroll_edge_pass_limit' },
  // The `scroll top` or `scroll bottom` gestures did not move the content.
  edgeNoProgress: { reason: 'scroll_edge_no_progress' },
  // `scroll top` or `scroll bottom` could not read the screen between passes.
  edgeCaptureUnreadable: { reason: 'scroll_edge_capture_unreadable' },
} as const satisfies ReasonTable<'scroll'>;
