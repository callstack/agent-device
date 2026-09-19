import type { AndroidToolHost } from '@agent-device/contracts/platform-runtime-host';
import { loadAndroidMechanics } from './platform-runtime-android-mechanics.ts';

/** Provider-aware Android transport. Command semantics and arguments stay package-owned. */
export function createAndroidToolHost(): AndroidToolHost {
  return Object.freeze({
    /**
     * Asks this build's clipboard service whether it implements a shell command, and reads the answer
     * off the service's own sentence rather than off the exit status, which a service with no shell
     * command returns as success.
     *
     * The probe runs with `allowFailure`, so a device that is offline, unauthorized, timed out or
     * otherwise broken comes back as an ordinary non-zero result rather than a throw, and the
     * classification keeps a call that failed for another reason from being read as a missing shell
     * command.
     */
    probeClipboardShellSupport: async (device, signal) => {
      try {
        const { runAndroidShell, androidClipboardShellSupportForResult } =
          await loadAndroidMechanics();
        const result = await runAndroidShell(device, ['cmd', 'clipboard', 'get', 'text'], {
          allowFailure: true,
          signal,
        });
        return await androidClipboardShellSupportForResult(result);
      } catch {
        return 'probe-failed';
      }
    },
    runAdb: async (device, args, options, signal) => {
      const { runAndroidAdb } = await loadAndroidMechanics();
      const result = await runAndroidAdb(device, args, {
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
