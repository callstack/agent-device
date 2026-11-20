import { AppError } from '@agent-device/kernel/errors';
import { createScopedProvider } from '@agent-device/kernel/scoped-provider';
import type { WebProvider } from '@agent-device/contracts/web-provider';

export type {
  WebSnapshotOptions,
  WebSnapshotResult,
  WebAudioProbeOptions,
  WebAudioProbeResult,
  WebProvider,
} from '@agent-device/contracts/web-provider';

/**
 * The un-composed fallback: a request that reaches a web device without a composed provider is a
 * composition bug, so it fails closed instead of borrowing a host it was never given (#3794).
 * Optional capabilities stay absent, exactly as a provider that lacks them reports them.
 */
function uncomposedWebProviderFailure(): Promise<never> {
  return Promise.reject(
    new AppError('COMMAND_FAILED', 'The web provider is not composed for this request.', {
      reason: 'web-provider-missing',
    }),
  );
}

const uncomposedWebProvider: WebProvider = {
  open: () => uncomposedWebProviderFailure(),
  close: () => uncomposedWebProviderFailure(),
  snapshot: () => uncomposedWebProviderFailure(),
  screenshot: () => uncomposedWebProviderFailure(),
  setViewport: () => uncomposedWebProviderFailure(),
  click: () => uncomposedWebProviderFailure(),
  fill: () => uncomposedWebProviderFailure(),
  typeText: () => uncomposedWebProviderFailure(),
  scroll: () => uncomposedWebProviderFailure(),
};

const webProviderScope = createScopedProvider(uncomposedWebProvider);

export function resolveWebProvider(provider?: WebProvider): WebProvider {
  return webProviderScope.resolve(provider);
}

/** True only for an explicitly request-scoped provider, never the local fallback. */
export function hasScopedWebProvider(): boolean {
  return webProviderScope.hasScope();
}

export async function withWebProvider<T>(
  provider: WebProvider | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return await webProviderScope.run(provider, fn);
}
