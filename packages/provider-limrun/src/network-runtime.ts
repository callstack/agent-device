import type {
  NetworkCaptureStartInput,
  NetworkCaptureStartResult,
  NetworkCaptureStopResult,
  NetworkDumpInput,
  NetworkDumpResult,
  NetworkRuntimeOperations,
} from '@agent-device/contracts/network-runtime';
import type { LimrunNetworkCapture } from './network-capture.ts';

/**
 * The Limrun network seam for one bound device session.
 *
 * One source serves a dump (ADR 0037): the live Limrun tunnel capture when a capture has been
 * started, otherwise the session app-log parse. The dump never installs instrumentation and never
 * switches source mid-session; only `start`/`stop` change it.
 */
export type LimrunNetworkOperations = NetworkRuntimeOperations &
  Readonly<{
    /** The app-log parse, kept for the dump path when no capture was started. */
    appLogNetworkDump(input: NetworkDumpInput): Promise<NetworkDumpResult>;
  }>;

export function bindLimrunNetworkOperations(
  input: Readonly<{
    capture: LimrunNetworkCapture;
    appLogDump(input: NetworkDumpInput): Promise<NetworkDumpResult>;
  }>,
): LimrunNetworkOperations {
  return Object.freeze({
    networkDump: async (dumpInput): Promise<NetworkDumpResult> => {
      if (!input.capture.running) return await input.appLogDump(dumpInput);
      return Object.freeze({
        source: 'provider' as const,
        // Names the exact source behind the provider answer; the enum itself belongs to the
        // shared capture-source record (ADR 0037).
        backend: 'limrun-tunnel' as const,
        entries: input.capture.readEntries({
          maxEntries: dumpInput.maxEntries,
          include: dumpInput.include,
        }),
        notes: input.capture.notes(),
      });
    },
    appLogNetworkDump: (dumpInput) => input.appLogDump(dumpInput),
    networkCaptureStart: async (
      startInput: NetworkCaptureStartInput,
    ): Promise<NetworkCaptureStartResult> => {
      const started = await input.capture.start(startInput.hosts);
      if (!started.ok) {
        return Object.freeze({
          started: false as const,
          reason: started.reason,
          message: started.message,
        });
      }
      return Object.freeze({
        started: true as const,
        source: input.capture.source,
        hosts: started.hosts,
        // The tunnel sees a connection only from its start on: an app the session already has
        // open launched before it, so tell the operator to relaunch instead of relaunching.
        requiresRelaunch: startInput.appBundleId !== undefined,
        capturingBodies: started.capturingBodies,
      });
    },
    networkCaptureStop: async (): Promise<NetworkCaptureStopResult> => await input.capture.stop(),
  });
}
