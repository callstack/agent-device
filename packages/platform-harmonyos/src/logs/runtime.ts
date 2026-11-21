import { deviceShellArgv } from '@agent-device/kernel/device-shell';
import type {
  AppLogBackgroundProcess,
  AppLogBackgroundProcessRequest,
  AppLogProcessCommand,
  AppLogProcessStart,
  AppLogRuntimeHost,
} from '@agent-device/contracts/app-log-runtime';
import {
  createPidScopedAppLogRuntimeOwner,
  firstNumericAppLogPid,
} from '@agent-device/capture-kit';
import type { HarmonyToolbox } from '../toolbox.ts';
import { createHarmonyAppLogEnvelope, harmonyAppLogDescriptorCodec } from './descriptor.ts';

const START_UNAVAILABLE_HINT =
  'The selected HarmonyOS transport cannot start a background hilog stream.';

/**
 * HarmonyOS app logs. Both HDC commands this owner runs — the one-shot `pidof` poll and the streamed
 * `hilog` — go through the command route the plugin built from the host its `setup` received, so the
 * family's documented toolchain roots are prepared for the stream exactly as they are for discovery
 * and interaction. The runtime host's own process transport spawns with the core's environment,
 * which names none of this family's roots.
 */
export function createHarmonyAppLogRuntime(host: AppLogRuntimeHost, toolbox: HarmonyToolbox) {
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
    process: async ({ device, input }) => ({
      resolvePid: async (signal) =>
        firstNumericAppLogPid(
          (
            await toolbox.hdc.runShell(device, ['pidof', input.appBundleId], {
              allowFailure: true,
              timeoutMs: 5_000,
              ...(signal === undefined ? {} : { signal }),
            })
          ).stdout,
        ),
      // Resolved per start, so a toolchain installed while the daemon runs is streamed with too.
      command: async (pid) => ({
        kind: 'host',
        request: {
          executable: await toolbox.hdc.executable(),
          args: deviceShellArgv('hdc', 'shell', ['hilog', '-P', pid], ['-t', device.id]),
          allowFailure: true,
        },
      }),
      start: harmonyHilogProcessStart(toolbox),
    }),
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

/**
 * The stream's route: the setup host's managed process service, asked through the family's command
 * runner so the spawn carries the `PATH` that runner prepares. The service owns the marker, the stop,
 * and the cleanup, exactly as it does for a stream the core's own transport started.
 */
function harmonyHilogProcessStart(toolbox: HarmonyToolbox): AppLogProcessStart {
  return async (request, signal) =>
    await startHarmonyHilog(toolbox, harmonyHostCommand(request.command), request, signal);
}

async function startHarmonyHilog(
  toolbox: HarmonyToolbox,
  command: AppLogHdcCommand,
  request: AppLogBackgroundProcessRequest,
  signal: AbortSignal | undefined,
): Promise<AppLogBackgroundProcess> {
  return await toolbox.commands.start(command.executable, command.args, {
    output: request.output,
    ...(request.markerPath === undefined ? {} : { markerPath: request.markerPath }),
    allowFailure: command.allowFailure ?? true,
    ...(signal === undefined ? {} : { signal }),
  });
}

/** The HDC command an app-log plan mints: an executable plus the argv to run with it. */
type AppLogHdcCommand = Extract<AppLogProcessCommand, { kind: 'host' }>['request'];

/**
 * The plan's command for this family. It mints host commands only, so an adb-scoped one here means
 * the plan was built for another family.
 */
function harmonyHostCommand(command: AppLogProcessCommand): AppLogHdcCommand {
  if (command.kind === 'host') return command.request;
  throw new Error(`HarmonyOS app logs cannot stream a ${JSON.stringify(command.kind)} command`);
}
