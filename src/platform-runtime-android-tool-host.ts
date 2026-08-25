import type { AndroidToolHost } from '@agent-device/contracts/platform';

/** Provider-aware Android transport. Command semantics and arguments stay package-owned. */
export function createAndroidToolHost(): AndroidToolHost {
  return Object.freeze({
    /**
     * Definitive in both directions where adb answers, and honest when it does not: a transport
     * failure reports `probe-failed` rather than a guess, so admission can refuse instead of
     * fabricating availability the operation would then reject.
     */
    probeClipboardShellSupport: async (device, signal) => {
      try {
        const { runAndroidAdb, isClipboardShellUnsupported } =
          await import('./platforms/android/adb.ts');
        const result = await runAndroidAdb(device, ['shell', 'cmd', 'clipboard', 'get', 'text'], {
          allowFailure: true,
          signal,
        });
        return isClipboardShellUnsupported(result.stdout, result.stderr)
          ? 'unsupported'
          : 'supported';
      } catch {
        return 'probe-failed';
      }
    },
    runAdb: async (device, args, options, signal) => {
      const { runAndroidAdb } = await import('./platforms/android/adb.ts');
      const result = await runAndroidAdb(device, [...args], {
        allowFailure: options.allowFailure,
        timeoutMs: options.timeoutMs,
        signal,
      });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    },
    installPackage: async (device, packagePath, options, signal) => {
      const { resolveAndroidAdbProvider } = await import('./platforms/android/adb-executor.ts');
      const provider = resolveAndroidAdbProvider(device);
      const result = provider.install
        ? await provider.install(packagePath, { replace: options.replace, signal })
        : await provider.exec(['install', ...(options.replace ? ['-r'] : []), packagePath], {
            signal,
          });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    },
    installBundle: async (device, bundlePath, mode, signal) => {
      const { resolveAndroidAdbProvider } = await import('./platforms/android/adb-executor.ts');
      const installer = resolveAndroidAdbProvider(device).installBundle;
      if (!installer) return false;
      await installer(bundlePath, { mode, signal });
      return true;
    },
  });
}
