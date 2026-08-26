import { withAdbFailureHints } from './adb-failure.ts';
import { requireAndroidAdbHost } from './adb-host.ts';
import type {
  AndroidAdbExecutor,
  AndroidAdbExecutorResult,
  AndroidAdbProvider,
} from './adb-transport.ts';

// The single funnel every provider passes through before the cluster uses it: bare executors
// become one-method providers, results crossing the SDK boundary are coerced, and every adb
// funnel gains classified failure hints.

// Providers already enriched by withAdbFailureHintProvider, so repeated
// normalization resolves to the same object instead of stacking wrappers.
const adbFailureHintProviders = new WeakSet<AndroidAdbProvider>();

export function normalizeAndroidAdbProvider(
  provider: AndroidAdbProvider | AndroidAdbExecutor,
): AndroidAdbProvider {
  return withAdbFailureHintProvider(typeof provider === 'function' ? { exec: provider } : provider);
}

/**
 * Wraps every promise-returning adb funnel a provider exposes — `exec` plus the
 * semantic `pull`/`install`/`installBundle` methods that bypass it — so a
 * provider failure (e.g. an INSTALL_FAILED verdict from `provider.install`)
 * carries the same classified hint as local execution. Applied once inside
 * {@link normalizeAndroidAdbProvider}, the single funnel every provider passes
 * through; the local provider needs no wrap because its methods delegate to the
 * already-enriched serial executor.
 */
function withAdbFailureHintProvider(provider: AndroidAdbProvider): AndroidAdbProvider {
  if (adbFailureHintProviders.has(provider)) return provider;
  const enriched: AndroidAdbProvider = {
    ...provider,
    exec: withAdbFailureHints(coerceAdbResults(provider.exec)),
    ...(provider.pull ? { pull: withAdbFailureHints(coerceAdbResults(provider.pull)) } : {}),
    ...(provider.install
      ? { install: withAdbFailureHints(coerceAdbResults(provider.install)) }
      : {}),
    ...(provider.installBundle
      ? { installBundle: withAdbFailureHints(provider.installBundle) }
      : {}),
  };
  adbFailureHintProviders.add(enriched);
  return enriched;
}

// Providers are SDK-supplied callbacks whose results cross an unchecked
// boundary; coerce them once here (see the host port's coerceAdbResult) so
// downstream code can trust the result types. Wrapped inside the same
// enrichment pass so the WeakSet memo above also prevents coercer stacking.
function coerceAdbResults<Args extends unknown[]>(
  call: (...args: Args) => Promise<AndroidAdbExecutorResult>,
): (...args: Args) => Promise<AndroidAdbExecutorResult> {
  return async (...args) => requireAndroidAdbHost().coerceAdbResult(await call(...args));
}
