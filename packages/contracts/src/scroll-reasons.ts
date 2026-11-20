import type { CommandReasonRow } from './command-reasons.ts';

/** Every `details.reason` the scroll family publishes, each with the command that raises it. */
export const SCROLL_REASONS = {
  // A directional scroll whose container still hides content did not move.
  noProgress: { reason: 'scroll_no_progress', command: 'scroll' },
  // The on-screen keyboard leaves too little of the scroll surface; Android and the iOS runner.
  keyboardOccludesSurface: { reason: 'scroll_keyboard_occludes_surface', command: 'scroll' },
  // `scroll refresh` started away from the top of the content.
  refreshNotAtTop: { reason: 'scroll_refresh_not_at_top', command: 'scroll' },
  // `--max-passes` came without `--until`.
  maxPassesRequiresUntil: { reason: 'scroll_max_passes_requires_until', command: 'scroll' },
  // `--max-passes` is not an integer inside its range.
  maxPassesInvalid: { reason: 'scroll_max_passes_invalid', command: 'scroll' },
  // `--until` spent its pass budget before the selector was visible.
  untilPassLimit: { reason: 'scroll_until_pass_limit', command: 'scroll' },
  // `--until` reached the end of the content before the selector was visible.
  untilEdgeReached: { reason: 'scroll_until_edge_reached', command: 'scroll' },
  // `--until` gestures never shifted the content.
  untilNoProgress: { reason: 'scroll_until_no_progress', command: 'scroll' },
  // `--until` could not read the screen between passes.
  untilCaptureUnreadable: { reason: 'scroll_until_capture_unreadable', command: 'scroll' },
  // `scroll top|bottom` reached its safety limit before the edge.
  edgePassLimit: { reason: 'scroll_edge_pass_limit', command: 'scroll' },
  // `scroll top|bottom` gestures never shifted the content.
  edgeNoProgress: { reason: 'scroll_edge_no_progress', command: 'scroll' },
  // `scroll top|bottom` could not read the screen between passes.
  edgeCaptureUnreadable: { reason: 'scroll_edge_capture_unreadable', command: 'scroll' },
} as const satisfies Record<string, CommandReasonRow>;
