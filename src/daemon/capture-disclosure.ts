import type { SnapshotState } from '@agent-device/kernel/snapshot';
import { systemSurfaceDisclosure } from '@agent-device/contracts/android-system-surface-disclosure';
import { iosSystemSurfaceDisclosure } from '@agent-device/contracts/ios-system-surface';
import { iosTargetActivationDisclosure } from '@agent-device/contracts/ios-target-activation';
import type { DaemonResponse } from './daemon-request.ts';

/** The capture provenance a response must be disclosed against (#2438, #2682). */
export type CaptureProvenance = Pick<
  SnapshotState,
  'systemSurfaceOnly' | 'iosSystemSurfaceBundleId' | 'targetActivation'
>;

/**
 * The foreground repair THIS request paid for, filled by the capture path only when the request
 * actually captured a tree (#2682).
 *
 * Separate from the consumed tree on purpose. A selector read may answer from a cached or stored
 * tree — that tree still describes the surface the response is about, which is what #2438 discloses
 * — but a cache hit performed no device work, so it can own no repair. Stamping the repair off the
 * consumed tree would tell a command "you found the session app out of foreground" when it never
 * looked, which is a fabricated observation rather than a disclosure.
 */
export type RequestActivationProof = {
  state?: CaptureProvenance;
};

/**
 * Note the repair a capture paid for, and hand that capture back. First fact wins: a later capture in
 * the same request that reports no repair — a sparse recovery's fresh tree, a poll's fact-less read —
 * cannot erase the capture that did (#2682). One rule, because three capture paths owe it and a
 * hand-copied condition drifts from the other two the moment one of them learns something.
 */
export function recordActivationProof<T extends CaptureProvenance>(
  proof: RequestActivationProof | undefined,
  snapshot: T,
): T {
  if (proof !== undefined && proof.state === undefined && snapshot.targetActivation !== undefined) {
    proof.state = snapshot;
  }
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
 * Disclose a foreground repair the consumed capture carried (#2682). The fact applies to the whole
 * tree, so it travels as response-level metadata and its sentence is APPENDED — an earlier warning
 * (staleness, quality, an occluding surface) is never replaced. The typed fact lands even when the
 * sentence was already carried: the field is this response's own claim, independent of who spoke.
 */
export function withTargetActivationDisclosure(
  response: DaemonResponse,
  snapshot: CaptureProvenance | undefined,
): DaemonResponse {
  const fact = snapshot?.targetActivation;
  if (!fact) return response;
  const disclosed = appendDisclosure(response, iosTargetActivationDisclosure(fact), 'warnings');
  if (!disclosed.ok) return disclosed;
  return { ...disclosed, data: { ...disclosed.data, targetActivation: fact } };
}

/**
 * Every capture-provenance disclosure a response owes, from the two different things a capture can
 * prove: what the answered tree describes (#2438 — cache tiers included, because the surface is
 * still on screen) and what this request's own capture found (#2682 — cache hits excluded, because
 * a request that captured nothing repaired nothing).
 */
export function withCaptureDisclosures(params: {
  response: DaemonResponse;
  consumedTree: CaptureProvenance | undefined;
  activationProof?: RequestActivationProof;
}): DaemonResponse {
  const { response, consumedTree, activationProof } = params;
  return withTargetActivationDisclosure(
    withSystemSurfaceDisclosure(response, consumedTree),
    activationProof?.state,
  );
}

/**
 * Which success-side field a disclosure enters. #2438's surface sentence shipped on the singular
 * `warning`; the repair sentence ships on the `warnings` array beside the typed fact that travels
 * with it. Failure has one carrier for both: `error.details.hint`.
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
    const details = response.error.details ?? {};
    return {
      ...response,
      error: {
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
    : [response.error.details?.hint];
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
