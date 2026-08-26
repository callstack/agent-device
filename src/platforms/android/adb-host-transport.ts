import { AsyncLocalStorage } from 'node:async_hooks';
import { coerceExecResult, runCmd, type ExecOptions, type ExecResult } from '../../utils/exec.ts';

/**
 * Runs one host-level adb invocation — global (`adb devices`) or device-scoped
 * (`adb -s <serial> …`). Providers install a scoped transport so host-level adb
 * traffic follows their tunnel instead of shelling out to local adb.
 */
export type AndroidAdbHostTransport = (
  args: string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

const androidAdbHostTransportScope = new AsyncLocalStorage<AndroidAdbHostTransport>();

// Single construction path for host adb. Without an installed transport this
// must stay plain `runCmd('adb', …)` so the exec layer's command-executor
// interception (provider scopes) sees the call exactly as before.
export async function runAndroidHostAdb(
  args: string[],
  options?: ExecOptions,
): Promise<ExecResult> {
  const transport = androidAdbHostTransportScope.getStore();
  if (!transport) return await runCmd('adb', args, options);
  return coerceExecResult(await transport(args, options));
}

export async function withAndroidHostAdbTransport<T>(
  transport: AndroidAdbHostTransport,
  fn: () => Promise<T>,
): Promise<T> {
  return await androidAdbHostTransportScope.run(transport, fn);
}
