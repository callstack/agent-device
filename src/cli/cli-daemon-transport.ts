import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type { CommandProgressState } from '@agent-device/command-output';
import type { AgentDeviceDaemonTransport } from '@agent-device/contracts/client';
import type { CliFlags } from '@agent-device/contracts/command';
import type { sendToDaemon } from '@agent-device/daemon-client';
import { createStderrCommandProgressSink } from '../commands/command-progress.ts';
import type { ReplayTestReporterRuntime } from './replay-test/reporting.ts';

// The client transports built on the daemon transport one CLI run sends through.

type CliDaemonTransport = typeof sendToDaemon;
type CliDaemonRequest = Parameters<CliDaemonTransport>[0];
type CliDaemonTransportOptions = Parameters<CliDaemonTransport>[1];
type ClientDaemonRequest = Parameters<AgentDeviceDaemonTransport>[0];

type CliDaemonTransportSetup = {
  host: HostEnvironment;
  command: string;
  flags: CliFlags;
  replayTestReporterRuntime?: ReplayTestReporterRuntime;
  commandProgress: CommandProgressState;
  transport: CliDaemonTransport;
};

/**
 * A remote connection reads each daemon reply for the leases its request ended, and forgets the
 * stored lease when the reply names it.
 */
export function createCliDaemonTransport(
  options: CliDaemonTransportSetup,
): AgentDeviceDaemonTransport {
  const send = createCliProgressTransport(options);
  if (!options.flags.remoteConfig) return send;
  return async (req, context) => {
    const response = await send(req, context);
    const { forgetEndedConnectionLease } = await import('./connection/ended-lease.ts');
    forgetEndedConnectionLease(options.flags, response, options.host);
    return response;
  };
}

/**
 * The human CLI renders streamed progress itself: `test` hands its events to the
 * replay-test reporter, every other command streams `command` lines to stderr
 * through `commandProgress`, whose state the output formatters then read (a
 * doctor summary does not repeat checks progress already printed). `--json` opts
 * out of progress entirely, so it installs no sink.
 */
function createCliProgressTransport(options: CliDaemonTransportSetup): AgentDeviceDaemonTransport {
  const { command, flags, replayTestReporterRuntime, transport } = options;
  if (flags.json) return createClientDaemonTransport(transport);
  const onProgress =
    command === 'test' && replayTestReporterRuntime
      ? replayTestReporterRuntime.onProgress
      : createStderrCommandProgressSink(options.commandProgress, options.host.env);
  return async (req, context) => {
    const transportOptions = { ...context, onProgress };
    return await sendClientRequestToCliTransport(
      transport,
      {
        ...req,
        meta: {
          ...req.meta,
          requestProgress: command === 'test' ? 'replay-test' : 'command',
        },
      },
      transportOptions,
    );
  };
}

export function createClientDaemonTransport(
  transport: CliDaemonTransport,
): AgentDeviceDaemonTransport {
  return async (req, context) => await sendClientRequestToCliTransport(transport, req, context);
}

async function sendClientRequestToCliTransport(
  transport: CliDaemonTransport,
  req: ClientDaemonRequest,
  options?: CliDaemonTransportOptions,
): ReturnType<CliDaemonTransport> {
  return await transport(req as CliDaemonRequest, options);
}
