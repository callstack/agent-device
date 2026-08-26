import type { AppleToolHost } from '@agent-device/contracts/platform-runtime-host';

export function createAppleToolHost(): AppleToolHost {
  return Object.freeze({
    isXcrunAvailable: async (signal?: AbortSignal) => {
      const { resolveAppleToolProvider } = await awaitPreservingAbortReason(
        async () => await import('./platforms/apple/core/tool-provider.ts'),
        signal,
      );
      const available = await awaitPreservingAbortReason(
        async () => await resolveAppleToolProvider().whichCommand('xcrun'),
        signal,
      );
      return available;
    },
    run: async (request, signal) => {
      const { runXcrun } = await awaitPreservingAbortReason(
        async () => await import('./platforms/apple/core/tool-provider.ts'),
        signal,
      );
      const result = await awaitPreservingAbortReason(
        async () =>
          await runXcrun([request.tool, ...request.args], {
            allowFailure: request.allowFailure,
            signal,
            timeoutMs: request.timeoutMs,
          }),
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
