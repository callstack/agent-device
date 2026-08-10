import { AppError } from '@agent-device/kernel/errors';
import type { AppLogRuntimeHost } from '@agent-device/contracts/platform';
import {
  createPidScopedAppLogRuntimeOwner,
  resolveFirstNumericAppLogPid,
} from '@agent-device/capture-kit';
import { createHarmonyAppLogEnvelope, harmonyAppLogDescriptorCodec } from './descriptor.ts';

const START_UNAVAILABLE_HINT =
  'The selected HarmonyOS transport cannot start a background hilog stream.';

export function createHarmonyAppLogRuntime(host: AppLogRuntimeHost) {
  return createPidScopedAppLogRuntimeOwner(host, {
    family: 'harmonyos',
    backend: 'harmonyos',
    label: 'HarmonyOS',
    codec: harmonyAppLogDescriptorCodec,
    startUnavailableHint: START_UNAVAILABLE_HINT,
    cleanupFailureMessage: 'HarmonyOS app-log cleanup did not settle every owned resource',
    doctor: async (_context, appBundleId) => ({
      backend: 'harmonyos',
      checks: {},
      notes: appBundleId
        ? []
        : ['No app bundle is tracked in this session. Run open <app> first for app-scoped logs.'],
    }),
    process: async ({ host: runtimeHost, device, input, signal }) => {
      const hdc = await prepareHarmonyLogs(runtimeHost, signal);
      return {
        resolvePid: async (pidSignal) =>
          await resolveFirstNumericAppLogPid(
            runtimeHost,
            {
              executable: hdc,
              args: ['-t', device.id, 'shell', 'pidof', input.appBundleId],
              allowFailure: true,
              timeoutMs: 5_000,
            },
            pidSignal,
          ),
        command: (pid) => ({
          kind: 'host',
          request: {
            executable: hdc,
            args: ['-t', device.id, 'shell', 'hilog', '-P', pid],
            allowFailure: true,
          },
        }),
      };
    },
    descriptor: ({ artifacts }) => ({ transport: 'harmony-hilog', ...artifacts }) as const,
    envelope: ({ input, device, owner, descriptor }) =>
      createHarmonyAppLogEnvelope({
        sessionId: input.sessionId,
        device,
        owner,
        fence: input.fence,
        descriptor,
      }),
  });
}

async function prepareHarmonyLogs(host: AppLogRuntimeHost, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  await preserveHarmonyCancellation(async () => await host.toolchains.prepare('harmonyos'), signal);
  signal.throwIfAborted();
  const hdc = await preserveHarmonyCancellation(
    async () => await host.commands.which('hdc'),
    signal,
  );
  signal.throwIfAborted();
  if (!hdc) {
    throw new AppError('TOOL_MISSING', 'hdc not found in PATH', {
      hint: 'Install HarmonyOS Command Line Tools, then add its sdk/default/openharmony/toolchains directory to PATH.',
    });
  }
  return hdc;
}

async function preserveHarmonyCancellation<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  }
}
