import type { SnapshotState } from '@agent-device/kernel/snapshot';
import { systemSurfaceDisclosure } from '@agent-device/contracts/android-system-surface-disclosure';
import { iosSystemSurfaceDisclosure } from '@agent-device/contracts/ios-system-surface';
import { iosTargetActivationDisclosure } from '@agent-device/contracts/ios-target-activation';
import {
  formatGestureNoEffectWarning,
  formatGestureUnsettledWarning,
} from '@agent-device/capture-kit/post-gesture-stability';
import type { DaemonResponse } from './daemon-request.ts';

/** The capture provenance a response must be disclosed against (#2438, #2682, gesture outcomes). */
export type CaptureProvenance = Pick<
  SnapshotState,
  'systemSurfaceOnly' | 'iosSystemSurfaceBundleId'
> &
  TreeFacts;

/** Facts about a whole captured tree, each disclosed as a typed field plus its sentence. */
type TreeFacts = Pick<SnapshotState, 'targetActivation' | 'unsettledGesture' | 'gestureNoEffect'>;

/**
 * The whole-tree facts THIS request's own captures observed, filled by the capture path only when the
 * request actually captured a tree: the foreground repair it paid for (#2682) and the outcome of the
 * gesture it read after: a surface that never settled, or a proven no-effect gesture (#1600).
 *
 * Separate from the consumed tree on purpose. A selector read may answer from a cached or stored
 * tree — that tree still describes the surface the response is about, which is what #2438 discloses
 * — but a cache hit performed no device work, so it can own no repair. Stamping the repair off the
 * consumed tree would tell a command "you found the session app out of foreground" when it never
 * looked, which is a fabricated observation rather than a disclosure.
 */
export type RequestCaptureProof = TreeFacts;

/**
 * Note the facts a capture observed, and hand that capture back. First fact wins: a later capture in
 * the same request that reports neither — a sparse recovery's fresh tree, a poll's fact-less read, an
 * interaction's full-tree retry — cannot erase the capture that did. Only the first capture after a
 * gesture is compared against it, so a later one proves nothing about that gesture.
 */
export function recordCaptureProof<T extends CaptureProvenance>(
  proof: RequestCaptureProof | undefined,
  snapshot: T,
): T {
  if (proof === undefined) return snapshot;
  if (snapshot.targetActivation) proof.targetActivation ??= snapshot.targetActivation;
  if (snapshot.unsettledGesture) proof.unsettledGesture ??= snapshot.unsettledGesture;
  if (snapshot.gestureNoEffect) proof.gestureNoEffect ??= snapshot.gestureNoEffect;
  return snapshot;
}

/**
 * Append the occluding-system-surface disclosure to a selector-route response whose consumed
 * snapshot was a system surface: an Android notification shade / quick settings, or an iOS in-place
 * system sheet such as web sign-in or Apple Pay (#2438). Both found and not-found outcomes must
 * explain that app content is occluded: a match found inside the surface is not app content, and a
 * miss is expected while the surface covers the app.
 */
export function withSystemSurfaceDisclosure(
  response: DaemonResponse,
  snapshot: CaptureProvenance | undefined,
): DaemonResponse {
  const disclosure = snapshot?.iosSystemSurfaceBundleId
    ? iosSystemSurfaceDisclosure(snapshot.iosSystemSurfaceBundleId)
    : systemSurfaceDisclosure(snapshot);
  return disclosure ? appendDisclosure(response, disclosure, 'warning') : response;
}

/**
 * Disclose a fact about the whole answered tree. Its sentence is APPENDED, never replacing an earlier
 * warning, and the typed fact lands on either outcome (`data` or `error.details`) even when the
 * sentence was already carried.
 */
function withTreeFactDisclosure<K extends keyof TreeFacts>(
  response: DaemonResponse,
  key: K,
  fact: TreeFacts[K],
  sentence: (fact: NonNullable<TreeFacts[K]>) => string,
): DaemonResponse {
  if (!fact) return response;
  const disclosed = appendDisclosure(response, sentence(fact), 'warnings');
  return disclosed.ok
    ? { ...disclosed, data: { ...disclosed.data, [key]: fact } }
    : {
        ...disclosed,
        error: { ...disclosed.error, details: { ...disclosed.error.details, [key]: fact } },
      };
}

export function withTargetActivationDisclosure(
  response: DaemonResponse,
  snapshot: CaptureProvenance | undefined,
): DaemonResponse {
  return withTreeFactDisclosure(
    response,
    'targetActivation',
    snapshot?.targetActivation,
    iosTargetActivationDisclosure,
  );
}

/** The outcome of the gesture a post-gesture capture read: it never settled, or it moved nothing. */
function withGestureOutcomeDisclosure(
  response: DaemonResponse,
  facts: TreeFacts | undefined,
): DaemonResponse {
  return withTreeFactDisclosure(
    withTreeFactDisclosure(
      response,
      'unsettledGesture',
      facts?.unsettledGesture,
      formatGestureUnsettledWarning,
    ),
    'gestureNoEffect',
    facts?.gestureNoEffect,
    formatGestureNoEffectWarning,
  );
}

/**
 * Every capture-provenance disclosure a response owes, from the two different things a capture can
 * prove: what the answered tree describes (#2438 — cache tiers included, because the surface is
 * still on screen; a gesture outcome — a poll that later answered from another tree owes none)
 * and what this request's own capture found (#2682 — cache hits excluded, because a request that
 * captured nothing repaired nothing).
 */
export function withCaptureDisclosures(params: {
  response: DaemonResponse;
  consumedTree: CaptureProvenance | undefined;
  captureProof?: RequestCaptureProof;
}): DaemonResponse {
  const { response, consumedTree, captureProof } = params;
  return withTargetActivationDisclosure(
    withGestureOutcomeDisclosure(withSystemSurfaceDisclosure(response, consumedTree), consumedTree),
    captureProof,
  );
}

/**
 * Every fact an interaction's own captures observed. The gesture aims at the trees this request
 * captured, so a gesture outcome read anywhere in it is disclosed on success and failure alike.
 */
export function withRequestCaptureDisclosures(
  response: DaemonResponse,
  captureProof: RequestCaptureProof,
): DaemonResponse {
  return withTargetActivationDisclosure(
    withGestureOutcomeDisclosure(response, captureProof),
    captureProof,
  );
}

/**
 * Which success-side field a disclosure enters. #2438's surface sentence shipped on the singular
 * `warning`; the repair sentence ships on the `warnings` array beside the typed fact that travels
 * with it. Failure has one carrier for both: the hint request finalization keeps, which is
 * `error.hint` when the route set one and `error.details.hint` otherwise.
 */
type DisclosureCarrier = 'warning' | 'warnings';

/**
 * The ONE gate every disclosure passes before it enters a response, whichever carrier that response
 * uses. Routes nest — a failing `get text` under a repairing capture passes through the wrapper twice,
 * once in the selector route and once in the interaction route — so a wrapper that spoke
 * unconditionally would say it twice. Equality is on a sentence this module owns, never a text sniff:
 * a response already carrying it comes back untouched.
 */
function appendDisclosure(
  response: DaemonResponse,
  disclosure: string,
  carrier: DisclosureCarrier,
): DaemonResponse {
  if (carriesDisclosure(response, disclosure)) return response;
  if (!response.ok) {
    const { hint, details = {} } = response.error;
    return {
      ...response,
      error:
        typeof hint === 'string'
          ? { ...response.error, hint: appended(hint, disclosure) }
          : {
              ...response.error,
              details: { ...details, hint: appended(details.hint, disclosure) },
            },
    };
  }
  if (carrier === 'warnings') {
    return {
      ...response,
      data: {
        ...response.data,
        warnings: [...responseWarnings(response.data?.warnings), disclosure],
      },
    };
  }
  return {
    ...response,
    data: { ...response.data, warning: appended(response.data?.warning, disclosure) },
  };
}

/**
 * Every text a disclosure could already sit in, so a sentence spoken by an inner route cannot be
 * spoken again by the wrapper around it.
 */
function carriesDisclosure(response: DaemonResponse, disclosure: string): boolean {
  const carriers: unknown[] = response.ok
    ? [response.data?.warning, ...responseWarnings(response.data?.warnings)]
    : [response.error.hint, response.error.details?.hint];
  return carriers.some((carrier) => typeof carrier === 'string' && carrier.includes(disclosure));
}

function appended(existing: unknown, disclosure: string): string {
  return typeof existing === 'string' && existing.trim() !== ''
    ? `${existing}\n${disclosure}`
    : disclosure;
}

function responseWarnings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => entry !== undefined) : [];
}
