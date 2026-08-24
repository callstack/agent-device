import { isIosFamily } from '@agent-device/kernel/device';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { isActiveProviderDevice } from '../provider-device-runtime.ts';
import { isPostGestureStabilizationPending } from './deferred-interaction-outcome.ts';
import type { SessionState } from './types.ts';
import { readSimpleSelectorTarget } from '@agent-device/selectors';
import { asAppError } from '@agent-device/kernel/errors';
import type { ElementSelectorTapOptions } from '@agent-device/contracts/interaction';

export type DirectIosSelectorTarget = ElementSelectorTapOptions & { raw: string };

/**
 * Is this session eligible for a direct, tree-independent local XCTest
 * runner read/tap? Both the Maestro selector-tap route and the offscreen
 * refusal double-check probe (`src/daemon/offscreen-target-probe.ts`) share
 * this "local runner, not a provider-owned device" boundary — provider-owned
 * iOS devices resolve through their own interactor-backed runtime instead.
 *
 * The one difference between the two callers is explicit, not baked in: the
 * Maestro tap route skips itself while a post-gesture stabilization is
 * pending (it hands off to the tree-based runtime path instead), but the
 * double-check must NOT inherit that skip — it exists specifically to cover
 * the window where the bulk AX tree is stale (pending or just-cleared
 * stabilization), so excluding that window would defeat its purpose.
 */
export function isLocalIosRunnerSession(
  session: SessionState | undefined,
  options: { skipPendingPostGestureStabilization: boolean },
): session is SessionState {
  if (!session) return false;
  if (!isIosFamily(session.device)) return false;
  // This fast path talks directly to the local XCTest runner. Provider-owned
  // iOS devices must resolve through their interactor-backed snapshot runtime
  // instead, which keeps selectors and interaction guarantees on one backend.
  if (isActiveProviderDevice(session.device)) return false;
  if (options.skipPendingPostGestureStabilization && isPostGestureStabilizationPending(session)) {
    return false;
  }
  return true;
}

export function readSimpleIosSelectorTarget(params: {
  session: SessionState | undefined;
  selectorExpression: string;
}): DirectIosSelectorTarget | null {
  const { session, selectorExpression } = params;
  if (!isLocalIosRunnerSession(session, { skipPendingPostGestureStabilization: true })) {
    return null;
  }
  return readSimpleSelectorTarget(selectorExpression);
}

/**
 * The selector a bulk-tree node's OWN attributes give us for a direct runner
 * re-read: prefer the stable `id` (accessibility identifier), fall back to
 * `label`. Neither is guaranteed unique on the runner side — an ambiguous
 * match is the caller's problem to fail closed on, not this parser's.
 */
export function deriveDirectIosNodeSelector(
  node: Pick<SnapshotNode, 'identifier' | 'label'>,
): { key: 'id' | 'label'; value: string } | null {
  const identifier = node.identifier?.trim();
  if (identifier) return { key: 'id', value: identifier };
  const label = node.label?.trim();
  if (label) return { key: 'label', value: label };
  return null;
}

export function isDirectIosSelectorFallbackError(
  error: unknown,
  options: {
    /**
     * Read/query callers (wait/get/is): a runner ELEMENT_NOT_FOUND re-resolves
     * against the daemon tree, but AMBIGUOUS_MATCH still surfaces as-is.
     */
    allowElementNotFound?: boolean;
    /**
     * ADR 0011 delegation-on-error for interaction dispatches: the runner's
     * semantic failure shapes (ELEMENT_NOT_FOUND, AMBIGUOUS_MATCH) fall back
     * to the tree-based runtime path, which supplies runtime disambiguation,
     * non-hittable promotion/annotation, occlusion refusal, and rich selector
     * diagnostics/hints. Must stay OFF for Maestro replay dispatches
     * (allowNonHittableCoordinateFallback): replay matching is intentionally
     * runner-native, so those error shapes must surface unchanged.
     */
    delegateSemanticFailures?: boolean;
  } = {},
): boolean {
  const appError = asAppError(error);
  if (appError.code === 'ELEMENT_NOT_FOUND') {
    return options.delegateSemanticFailures === true || options.allowElementNotFound === true;
  }
  if (appError.code === 'AMBIGUOUS_MATCH') return options.delegateSemanticFailures === true;
  // Regular interactions delegate off-screen matches to the shared tree, which
  // can prefer an on-screen candidate or raise offscreen_selector. Maestro
  // replay keeps the typed runner outcome so its compatibility resolver can
  // apply Maestro-specific ranking and tab-strip inference instead.
  if (appError.code === 'ELEMENT_OFFSCREEN') {
    return options.delegateSemanticFailures !== false;
  }
  if (appError.code !== 'COMMAND_FAILED') return false;
  // Transport-failure classification stays message-based deliberately: the
  // sniffed shapes originate at 4+ scattered throw sites (runner-transport
  // deadline errors, runner-contract connect errors, runner-session's invalid
  // response) plus raw undici "fetch failed" TypeErrors that are only wrapped
  // into AppError at this boundary — and isRetryableRunnerError performs the
  // same message sniffing for retry policy. A typed transport marker needs a
  // wrapping layer around all of them in one change; tracked as Tier-3 error
  // cleanup, not worth entangling with this fallback decision.
  const message = appError.message.toLowerCase();
  return (
    message.includes('fetch failed') ||
    message.includes('timed out') ||
    message.includes('timeout') ||
    message.includes('runner did not accept connection') ||
    message.includes('invalid runner response')
  );
}
