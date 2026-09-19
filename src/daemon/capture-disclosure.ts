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
  return disclosure ? appendDisclosure(response, disclosure) : response;
}

/**
 * Disclose a foreground repair the consumed capture carried (#2682). The fact applies to the whole
 * tree, so it travels as response-level metadata and its sentence is APPENDED — an earlier warning
 * (staleness, quality, an occluding surface) is never replaced. A route whose platform capture
 * already said the identical thing is not told twice: both spellings come from the one shared
 * disclosure function, so this is equality on a known sentence, not a text sniff.
 */
export function withTargetActivationDisclosure(
  response: DaemonResponse,
  snapshot: CaptureProvenance | undefined,
): DaemonResponse {
  const fact = snapshot?.targetActivation;
  if (!fact) return response;
  if (!response.ok) return appendDisclosure(response, iosTargetActivationDisclosure(fact));
  const disclosure = iosTargetActivationDisclosure(fact);
  const warnings = responseWarnings(response.data?.warnings);
  const data = {
    ...response.data,
    targetActivation: fact,
    ...(warnings.includes(disclosure) ? {} : { warnings: [...warnings, disclosure] }),
  };
  return { ...response, data };
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

function responseWarnings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => entry !== undefined) : [];
}

function appendDisclosure(response: DaemonResponse, disclosure: string): DaemonResponse {
  if (response.ok) {
    const warning = appended(response.data?.warning, disclosure);
    return { ...response, data: { ...response.data, warning } };
  }
  const details = response.error.details ?? {};
  return {
    ...response,
    error: { ...response.error, details: { ...details, hint: appended(details.hint, disclosure) } },
  };
}

function appended(existing: unknown, disclosure: string): string {
  return typeof existing === 'string' && existing.trim() !== ''
    ? `${existing}\n${disclosure}`
    : disclosure;
}
