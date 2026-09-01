import type { AndroidToolHost } from '@agent-device/contracts/platform-runtime-host';
import { loadAndroidMechanics } from './platform-runtime-android-mechanics.ts';

/** Provider-aware Android transport. Command semantics and arguments stay package-owned. */
export function createAndroidToolHost(): AndroidToolHost {
  return Object.freeze({
    /**
     * Definitive in both directions only where adb actually answers, and honest everywhere else.
     * The probe runs with `allowFailure`, so a device that is offline, unauthorized, timed out or
     * otherwise broken comes back as an ordinary non-zero result rather than a throw.
     *
     * The exit code is read first and settles the answer on its own when it is zero, because on a
     * clean exit `stdout` is the clipboard's *contents* -- attacker-free but arbitrary user text,
     * which may well quote an error. Only a failed call can carry prose about the call itself, so
     * the missing-shell phrases are interpreted on non-zero exits alone. Every remaining result --
     * non-zero without that prose, or a transport throw -- is `probe-failed`, so admission refuses
     * instead of caching a verdict the operation would then contradict.
     */
    probeClipboardShellSupport: async (device, signal) => {
      try {
        const { runAndroidAdb, isClipboardShellUnsupported } = await loadAndroidMechanics();
        const result = await runAndroidAdb(device, ['shell', 'cmd', 'clipboard', 'get', 'text'], {
          allowFailure: true,
          signal,
        });
        if (result.exitCode === 0) return 'supported';
        return isClipboardShellUnsupported(result.stdout, result.stderr)
          ? 'unsupported'
          : 'probe-failed';
      } catch {
        return 'probe-failed';
      }
    },
    runAdb: async (device, args, options, signal) => {
      const { runAndroidAdb } = await loadAndroidMechanics();
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
      const { resolveAndroidAdbProvider } = await loadAndroidMechanics();
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
      const { resolveAndroidAdbProvider } = await loadAndroidMechanics();
      const installer = resolveAndroidAdbProvider(device).installBundle;
      if (!installer) return false;
      await installer(bundlePath, { mode, signal });
      return true;
    },
  });
}
