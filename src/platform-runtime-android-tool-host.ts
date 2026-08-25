import type { AndroidToolHost } from '@agent-device/contracts/platform';

/** Provider-aware Android transport. Command semantics and arguments stay package-owned. */
export function createAndroidToolHost(): AndroidToolHost {
  return Object.freeze({
    /**
     * Definitive in both directions only where adb actually answers, and honest everywhere else.
     * The probe runs with `allowFailure`, so a device that is offline, unauthorized, timed out or
     * otherwise broken comes back as an ordinary non-zero result rather than a throw: only a clean
     * exit proves the clipboard shell command exists, and only the recognized missing-shell prose
     * proves it does not. Every other result -- non-zero without that prose, or a transport throw
     * -- is `probe-failed`, so admission refuses instead of caching availability the operation
     * would then reject.
     */
    probeClipboardShellSupport: async (device, signal) => {
      try {
        const { runAndroidAdb, isClipboardShellUnsupported } =
          await import('./platforms/android/adb.ts');
        const result = await runAndroidAdb(device, ['shell', 'cmd', 'clipboard', 'get', 'text'], {
          allowFailure: true,
          signal,
        });
        if (isClipboardShellUnsupported(result.stdout, result.stderr)) return 'unsupported';
        return result.exitCode === 0 ? 'supported' : 'probe-failed';
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
