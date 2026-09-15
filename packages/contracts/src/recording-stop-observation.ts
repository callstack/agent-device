/**
 * What a recording backend observed about its recorder when it was asked to stop
 * (ADR 0024 2.2). This is the first of the two facts a stop answers; whether a playable export
 * exists is answered separately by the export itself.
 *
 * The observation describes what was observed, never what identity proved. An identity probe that
 * could not be read is `unconfirmed`, not `lost`, and a proven mismatch is `lost` even though the
 * same probe found nothing.
 *
 * The variants below define the vocabulary; they are not a claim that anything emits each one.
 * Today's producers answer `confirmed` — an exited `simctl` process, an acknowledged runner stop,
 * Android recorders proven gone, a stopped HarmonyOS toggle, a stopped browser provider — and `lost`
 * with `owner-session-lost` for an Apple recording whose session was invalidated. The unconfirmed
 * reasons and the two identity reasons for `lost` arrive with the steps that gain the probe or the
 * retry they describe; until a step owns one, a stop that cannot prove its recorder gone reports
 * that as its own error rather than serving an export labelled `unconfirmed`.
 */
export const RECORDER_OBSERVATION_VALUES = ['confirmed', 'unconfirmed', 'lost'] as const;

/** The one word every backend reports, and the word the `record stop` response serves. */
export type RecorderObservation = (typeof RECORDER_OBSERVATION_VALUES)[number];

/** The recorder was asked to stop and termination never became a fact. */
const RECORDER_UNCONFIRMED_REASONS = ['identity-unreadable', 'no-exit-in-budget'] as const;

export type RecorderUnconfirmedReason = (typeof RECORDER_UNCONFIRMED_REASONS)[number];

/** The recorder the backend was told to stop is not the one it started, or no longer holds it. */
const RECORDER_LOST_REASONS = [
  'identity-not-ours',
  'owner-session-lost',
  'native-artifact-absent',
] as const;

export type RecorderLostReason = (typeof RECORDER_LOST_REASONS)[number];

export type StopObservation =
  /** The recorder exited or acknowledged the stop meant for this recording. */
  | Readonly<{ recorder: 'confirmed' }>
  /** A probe was unreadable, or the recorder was signalled and no exit arrived in the budget. */
  | Readonly<{ recorder: 'unconfirmed'; why: RecorderUnconfirmedReason }>
  /** Identity proved the writer is someone else, or the session holding it died. */
  | Readonly<{ recorder: 'lost'; why: RecorderLostReason }>;

/** Validates an observation that came back from persisted JSON, where a mismatched reason is possible. */
export function isStopObservation(value: unknown): value is StopObservation {
  if (typeof value !== 'object' || value === null) return false;
  const candidate: { recorder?: unknown; why?: unknown } = value;
  if (!RECORDER_OBSERVATION_VALUES.some((word) => word === candidate.recorder)) return false;
  if (candidate.recorder === 'confirmed') return candidate.why === undefined;
  const reasons: readonly string[] =
    candidate.recorder === 'unconfirmed' ? RECORDER_UNCONFIRMED_REASONS : RECORDER_LOST_REASONS;
  return reasons.some((reason) => reason === candidate.why);
}
