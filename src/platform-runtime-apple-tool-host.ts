import type { AppleToolHost } from '@agent-device/contracts/platform-runtime-host';

export function createAppleToolHost(): AppleToolHost {
  return Object.freeze({
    isXcrunAvailable: async (signal?: AbortSignal) => {
      const { resolveAppleToolProvider } = await awaitPreservingAbortReason(
        async () => await import('@agent-device/platform-apple/tool-provider'),
        signal,
      );
      const provider = resolveAppleToolProvider();
      const available = await awaitPreservingAbortReason(
        async () => await provider.whichCommand('xcrun'),
        signal,
      );
      return available;
    },
    run: async (request, signal) => {
      const { resolveAppleToolProvider, runXcrun } = await awaitPreservingAbortReason(
        async () => await import('@agent-device/platform-apple/tool-provider'),
        signal,
      );
      const options = { allowFailure: request.allowFailure, signal, timeoutMs: request.timeoutMs };
      const result = await awaitPreservingAbortReason(
        async () =>
          request.tool === 'simctl'
            ? await resolveAppleToolProvider().simctl.run(request.args, options)
            : await runXcrun([request.tool, ...request.args], options),
        signal,
      );
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    },
  });
}

async function awaitPreservingAbortReason<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  try {
    const result = await operation();
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  }
}
