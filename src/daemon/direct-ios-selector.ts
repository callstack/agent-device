import { isIosFamily } from '../kernel/device.ts';
import { isActiveProviderDevice } from '../provider-device-runtime.ts';
import type { SessionState } from './types.ts';
import { tryParseSelectorChain } from '../selectors/index.ts';
import { asAppError } from '../kernel/errors.ts';
import type { ElementSelectorTapOptions } from '../core/interactor-types.ts';

export type DirectIosSelectorTarget = ElementSelectorTapOptions & { raw: string };

export function readSimpleIosSelectorTarget(params: {
  session: SessionState | undefined;
  selectorExpression: string;
}): DirectIosSelectorTarget | null {
  const { session, selectorExpression } = params;
  if (!session) return null;
  if (!isIosFamily(session.device)) return null;
  // This fast path talks directly to the local XCTest runner. Provider-owned
  // iOS devices must resolve through their interactor-backed snapshot runtime
  // instead, which keeps selectors and interaction guarantees on one backend.
  if (isActiveProviderDevice(session.device)) return null;
  if (session.postGestureStabilization) return null;
  const chain = tryParseSelectorChain(selectorExpression);
  if (!chain) return null;
  if (chain.selectors.length !== 1) return null;
  const selector = chain.selectors[0];
  if (!selector || selector.terms.length !== 1) return null;
  const term = selector.terms[0];
  if (!term || typeof term.value !== 'string') return null;
  if (!isRunnerNativeSelectorKey(term.key)) return null;
  return { key: term.key, value: term.value, raw: selector.raw };
}

function isRunnerNativeSelectorKey(key: string): key is DirectIosSelectorTarget['key'] {
  return key === 'id' || key === 'label' || key === 'text' || key === 'value';
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
