import type { AppleToolHost } from '@agent-device/contracts/platform';

export function createAppleToolHost(): AppleToolHost {
  return Object.freeze({
    isXcrunAvailable: async (signal?: AbortSignal) => {
      signal?.throwIfAborted();
      const { resolveAppleToolProvider } = await import('./platforms/apple/core/tool-provider.ts');
      signal?.throwIfAborted();
      const available = await resolveAppleToolProvider().whichCommand('xcrun');
      signal?.throwIfAborted();
      return available;
    },
    run: async (request, signal) => {
      signal?.throwIfAborted();
      const { runXcrun } = await import('./platforms/apple/core/tool-provider.ts');
      signal?.throwIfAborted();
      const result = await runXcrun([request.tool, ...request.args], {
        allowFailure: request.allowFailure,
        signal,
        timeoutMs: request.timeoutMs,
      });
      signal?.throwIfAborted();
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    },
  });
}
