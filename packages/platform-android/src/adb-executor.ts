// The `adb-executor` entry surface, kept for the root shim and the transitional #2041
// consumers. The implementation lives in focused owners: `adb-transport.ts` (vocabulary),
// `adb-failure.ts` (classification + hint enrichment), `adb-provider-normalization.ts`,
// `adb-provider-scope.ts` (request-scoped provider seam and routing),
// `adb-port-reverse.ts` (owner-tracked reverse mappings), and `adb-transfer.ts`
// (pull/install funnels).

import { AsyncLocalStorage } from 'node:async_hooks';
import { androidAdbResultError } from './adb-failure.ts';
import { requireAndroidAdbHost } from './adb-host.ts';
import type { AndroidAdbExecutorOptions, AndroidAdbExecutorResult } from './adb-transport.ts';

export {
  androidAdbResultError,
  attachAdbFailureHint,
  classifyAndroidAdbFailure as classifyAdbFailure,
} from './adb-failure.ts';
export { createAndroidPortReverseManager } from './adb-port-reverse.ts';
export {
  createDeviceAdbExecutor,
  createLocalAndroidAdbProvider,
  resolveAndroidAdbExecutor,
  resolveAndroidAdbProvider,
  resolveAndroidTextInjector,
  resolveAndroidTouchProvider,
  resolveScopedAndroidAdbBackgroundTransport,
  withAndroidAdbProvider,
} from './adb-provider-scope.ts';
export { installAndroidAdbPackage, pullAndroidAdbFile } from './adb-transfer.ts';
export type {
  AndroidAdbExecutor,
  AndroidAdbExecutorOptions,
  AndroidAdbExecutorResult,
  AndroidAdbProcess,
  AndroidAdbProvider,
  AndroidPortReverseEndpoint,
  AndroidTextInputAction,
  AndroidTouchInjector,
} from './adb-transport.ts';

/** Scoped override for host-global and explicitly serial-qualified adb argv. */
export type AndroidAdbHostTransport = (
  args: string[],
  options?: AndroidAdbExecutorOptions,
) => Promise<AndroidAdbExecutorResult>;

const androidAdbHostTransportScope = new AsyncLocalStorage<AndroidAdbHostTransport>();

/**
 * Runs host-level adb through one package-owned failure contract. A scoped
 * transport wins over the injected local host port; nested scopes are
 * innermost-first and restore automatically.
 */
export async function runAndroidHostAdb(
  args: string[],
  options?: AndroidAdbExecutorOptions,
): Promise<AndroidAdbExecutorResult> {
  const host = requireAndroidAdbHost();
  const transport = androidAdbHostTransportScope.getStore();
  const result = host.coerceAdbResult(
    transport
      ? await transport(args, options)
      : await host.execHostAdb(args, { ...options, allowFailure: true }),
  );
  if (!options?.allowFailure && result.exitCode !== 0) {
    throw androidAdbResultError(
      `adb ${args.join(' ')} exited with code ${result.exitCode}`,
      result,
    );
  }
  return result;
}

export async function withAndroidHostAdbTransport<T>(
  transport: AndroidAdbHostTransport,
  fn: () => Promise<T>,
): Promise<T> {
  return await androidAdbHostTransportScope.run(transport, fn);
}
