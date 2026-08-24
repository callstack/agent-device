import type { AppleOS } from '@agent-device/kernel/device';

/**
 * How each Apple OS names itself in agent-facing prose.
 *
 * Its own module because two callers need it — the defensive adapter check in
 * `apple-multitouch-support.ts` and the gesture refusal subject in `gesture-admission.ts` — and
 * neither the display table nor the wording it produces is a public contracts surface. Keeping it
 * out of a façade-re-exported module is what lets both callers share ONE copy of the wording.
 */
export const APPLE_OS_DISPLAY_NAMES: Record<AppleOS, string> = {
  ios: 'iOS',
  ipados: 'iPadOS',
  tvos: 'tvOS',
  watchos: 'watchOS',
  visionos: 'visionOS',
  macos: 'macOS',
};
