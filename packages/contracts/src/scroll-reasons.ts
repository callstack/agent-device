import type { ReasonTable } from '@agent-device/kernel/errors';

/** Every `details.reason` the scroll family publishes. */
export const SCROLL_REASONS = {
  noProgress: {
    reason: 'scroll_no_progress',
    summary: 'A directional scroll did not move a container that still hides content.',
    commands: ['scroll'],
  },
  keyboardOccludesSurface: {
    reason: 'scroll_keyboard_occludes_surface',
    summary: 'The on-screen keyboard leaves too little of the scroll surface to scroll.',
    commands: ['scroll'],
  },
  refreshNotAtTop: {
    reason: 'scroll_refresh_not_at_top',
    summary: '`scroll refresh` started away from the top of the content.',
    commands: ['scroll'],
  },
  maxPassesRequiresUntil: {
    reason: 'scroll_max_passes_requires_until',
    summary: '`--max-passes` was given without `--until`.',
    commands: ['scroll'],
  },
  maxPassesInvalid: {
    reason: 'scroll_max_passes_invalid',
    summary: '`--max-passes` is not an integer inside its range.',
    commands: ['scroll'],
  },
  untilPassLimit: {
    reason: 'scroll_until_pass_limit',
    summary: '`--until` used all its passes before the selector was visible.',
    commands: ['scroll'],
  },
  untilEdgeReached: {
    reason: 'scroll_until_edge_reached',
    summary: '`--until` reached the end of the content before the selector was visible.',
    commands: ['scroll'],
  },
  untilNoProgress: {
    reason: 'scroll_until_no_progress',
    summary: 'The `--until` gestures did not move the content.',
    commands: ['scroll'],
  },
  untilCaptureUnreadable: {
    reason: 'scroll_until_capture_unreadable',
    summary: '`--until` could not read the screen between passes.',
    commands: ['scroll'],
  },
  edgePassLimit: {
    reason: 'scroll_edge_pass_limit',
    summary: '`scroll top` or `scroll bottom` reached its pass limit before the edge.',
    commands: ['scroll'],
  },
  edgeNoProgress: {
    reason: 'scroll_edge_no_progress',
    summary: 'The `scroll top` or `scroll bottom` gestures did not move the content.',
    commands: ['scroll'],
  },
  edgeCaptureUnreadable: {
    reason: 'scroll_edge_capture_unreadable',
    summary: '`scroll top` or `scroll bottom` could not read the screen between passes.',
    commands: ['scroll'],
  },
} as const satisfies ReasonTable;
