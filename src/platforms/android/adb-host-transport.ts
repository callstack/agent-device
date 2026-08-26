import { AsyncLocalStorage } from 'node:async_hooks';
import { coerceExecResult, runCmd, type ExecOptions, type ExecResult } from '../../utils/exec.ts';
import { androidAdbResultError } from './adb-executor.ts';

/**
 * Runs one host-level adb invocation — global (`adb devices`) or device-scoped
 * (`adb -s <serial> …`). Providers install a scoped transport so host-level adb
 * traffic follows their tunnel instead of shelling out to local adb.
 *
 * Precedence: `runAndroidHostAdb` consults an installed transport BEFORE the
 * exec layer, so a transport wins over any surrounding AndroidAdbProvider
 * command-executor override — including `-s <serial>` argv belonging to other
 * devices and global commands. Installers must therefore install outside
 * request-bound provider scopes, or filter serials inside the implementation.
 *
 * Implementations receive the raw argv exactly as the host would run it and are
 * held to the same allowFailure/throw-on-nonzero contract the local fallback
 * provides: the seam enforces it by throwing the classified adb-failure error
 * on a nonzero exit unless `options.allowFailure` is set.
 */
export type AndroidAdbHostTransport = (
  args: string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

const androidAdbHostTransportScope = new AsyncLocalStorage<AndroidAdbHostTransport>();

// Single construction path for host adb. Without an installed transport this
// must stay plain `runCmd('adb', …)` so the exec layer's command-executor
// interception (provider scopes) sees the call exactly as before. Both arms
// share one failure contract: a nonzero exit rejects with the classified adb
// error unless `allowFailure` is set, so consumers cannot observe divergent
// semantics between an installed transport and local execution.
export async function runAndroidHostAdb(
  args: string[],
  options?: ExecOptions,
): Promise<ExecResult> {
  const transport = androidAdbHostTransportScope.getStore();
  const result = transport
    ? coerceExecResult(await transport(args, options))
    : await runCmd('adb', args, options);
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
