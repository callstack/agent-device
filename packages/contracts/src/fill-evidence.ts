import type { Rect } from '@agent-device/kernel/snapshot';

/**
 * The evidence a `fill` carries when it changed a field but could not confirm the text it sent.
 * Both the fill response and `Interactor.fill`'s return need these shapes, so they sit below both
 * of those modules rather than in either. This is the cross-language shape, not a platform's probing:
 * `packages/platform-android/src/fill-verification.ts` builds Android's copy of it, and the Apple
 * runner's `RunnerTests+TextEntryConfirmation.swift` builds the iOS one.
 */

/** The field a fill aimed at, as the platform that performed it names it. */
export type FillVerificationTarget = {
  resourceId: string | null;
  className: string | null;
  packageName: string | null;
  rect: Rect;
};

/**
 * Target-bound read-back evidence when a fill could not confirm the requested text. The observed
 * value may reflect app-owned formatting or altered input; this evidence makes no correctness
 * claim. Bound to the {@link FillVerificationTarget} it was collected against so a different
 * field cannot borrow the observation.
 */
export type FillUnconfirmedVerification = {
  verification: 'unconfirmed';
  requested: string;
  before: string | null;
  after: string | null;
  target: FillVerificationTarget;
};
