import type { Rect } from '@agent-device/kernel/snapshot';

/**
 * The evidence a `fill` carries when it changed a field but could not confirm the text it sent.
 * Both the fill response and `Interactor.fill`'s return need these shapes, so they sit below both
 * of those modules rather than in either. This is the cross-language shape, not Android's probing:
 * `packages/platform-android/src/fill-verification.ts` builds Android's copy of it.
 */

/** The field a fill aimed at, as the platform that performed it names it. */
export type FillVerificationTarget = {
  resourceId: string | null;
  className: string | null;
  packageName: string | null;
  rect: Rect;
};

/**
 * Target-bound evidence that a fill moved a field's content from `before` to `after` without raw
 * equality with `requested` being reachable, because app-owned formatting prevents it. Bound to the
 * {@link FillVerificationTarget} it was collected against so another field, or the same field after
 * it re-laid out, cannot borrow this evidence.
 */
export type FillUnconfirmedVerification = {
  verification: 'unconfirmed';
  requested: string;
  before: string | null;
  after: string | null;
  target: FillVerificationTarget;
};
