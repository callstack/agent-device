import {
  serializeCloseResult,
  serializeDeployResult,
  serializeDevice,
  serializeInstallFromSourceResult,
  serializeOpenResult,
  serializeSessionListEntry,
} from '../../client/client-shared.ts';
import type {
  AgentDeviceDevice,
  AgentDeviceSession,
  AppCloseResult,
  AppDeployResult,
  AppInstallFromSourceResult,
  AppOpenResult,
  CommandRequestResult,
  SessionCloseResult,
} from '../../client/client-types.ts';
import type {
  AgentArtifactsResult,
  CloudArtifactsResult,
  DaemonArtifactsResult,
} from '../../cloud-artifacts.ts';
import { readCommandMessage } from '../../utils/success-text.ts';
import type { CliOutput } from '../command-contract.ts';
import {
  consumeDoctorProgressRendered,
  formatDoctorCheckDetailLines,
  formatDoctorCheckSummaryLine,
} from '../../cli-doctor-output.ts';
import {
  messageCliOutput,
  messageOutput,
  resultOutput,
  type CliOutputFormatter,
} from '../output-common.ts';

function devicesCliOutput(result: AgentDeviceDevice[]): CliOutput {
  const data = { devices: result.map(serializeDevice) };
  return { data, text: result.map(formatDeviceLine).join('\n') };
}

function appsCliOutput(params: {
  result: string[];
  appsFilter?: 'user-installed' | 'all';
}): CliOutput {
  const data = { apps: params.result };
  return {
    data,
    stderr:
      params.appsFilter === 'all'
        ? 'Showing all apps, including system apps.\n'
        : 'Showing user-installed apps. Use --all to include system apps.\n',
    text:
      params.result.length > 0
        ? params.result.join('\n')
        : params.appsFilter === 'all'
          ? 'No apps found.'
          : 'No user-installed apps found.',
  };
}

function sessionCliOutput(
  result: { sessions: AgentDeviceSession[] } | { stateDir: string },
): CliOutput {
  if ('stateDir' in result) {
    return { data: result, text: result.stateDir };
  }
  const data = { sessions: result.sessions.map(serializeSessionListEntry) };
  return { data, text: JSON.stringify(data, null, 2) };
}

export function openCliOutput(result: AppOpenResult): CliOutput {
  const data = serializeOpenResult(result);
  const lines = [readCommandMessage(data)].filter((line): line is string => Boolean(line));
  if (typeof data.sessionStateDir === 'string') {
    lines.push(`Session state: ${data.sessionStateDir}`);
  }
  return { data, text: lines.join('\n') || null };
}

function closeCliOutput(result: AppCloseResult | SessionCloseResult): CliOutput {
  return messageCliOutput(serializeCloseResult(result));
}

function artifactsCliOutput(result: AgentArtifactsResult): CliOutput {
  if (isDaemonArtifactsResult(result)) {
    return {
      data: result,
      text:
        result.artifacts.length > 0
          ? result.artifacts.map(formatDaemonArtifactLine).join('\n')
          : (result.message ?? 'No daemon artifacts available.'),
    };
  }

  const emptyText = [result.message ?? `No cloud artifacts available for ${result.provider}.`];
  const retryCommand = formatCloudArtifactsRetryCommand(result);
  if (retryCommand) emptyText.push(`Retry: ${retryCommand}`);
  return {
    data: result,
    text:
      result.cloudArtifacts.length > 0
        ? result.cloudArtifacts.map(formatCloudArtifactLine).join('\n')
        : emptyText.join('\n'),
  };
}

function isDaemonArtifactsResult(result: AgentArtifactsResult): result is DaemonArtifactsResult {
  return 'source' in result && result.source === 'daemon';
}

function deployCliOutput(result: AppDeployResult): CliOutput {
  return messageCliOutput(serializeDeployResult(result));
}

function installFromSourceCliOutput(result: AppInstallFromSourceResult): CliOutput {
  return messageCliOutput(serializeInstallFromSourceResult(result));
}

function bootCliOutput(result: CommandRequestResult): CliOutput {
  const data = result as Record<string, unknown>;
  const platform = data.platform ?? 'unknown';
  const device = data.device ?? data.id ?? 'unknown';
  return { data, text: `Boot ready: ${device} (${platform})` };
}

function shutdownCliOutput(result: CommandRequestResult): CliOutput {
  const data = result as Record<string, unknown>;
  const platform = data.platform ?? 'unknown';
  const device = data.device ?? data.id ?? 'unknown';
  const shutdown = data.shutdown;
  const success =
    shutdown && typeof shutdown === 'object' && 'success' in shutdown
      ? (shutdown as { success?: unknown }).success === true
      : false;
  const status = success ? 'Shutdown' : 'Shutdown failed';
  return { data, text: `${status}: ${device} (${platform})` };
}

export function doctorCliOutput(result: CommandRequestResult): CliOutput {
  const data = result as Record<string, unknown>;
  const status = typeof data.status === 'string' ? data.status : 'unknown';
  const lines = [`Doctor: ${status}`];
  const checks = readDoctorChecks(data.checks);

  if (consumeDoctorProgressRendered()) {
    const summary = typeof data.summary === 'string' ? data.summary : undefined;
    if (summary) lines.push(summary);
  } else if (checks.length === 0) {
    const summary = typeof data.summary === 'string' ? data.summary : 'No blockers found.';
    lines.push(summary);
  } else {
    for (const check of checks) {
      lines.push(formatDoctorCheckSummaryLine(check));
      lines.push(...formatDoctorCheckDetailLines(check));
    }
  }
  return { data, text: lines.join('\n') };
}

export const managementCliOutputFormatters = {
  boot: resultOutput(bootCliOutput),
  shutdown: resultOutput(shutdownCliOutput),
  devices: resultOutput(devicesCliOutput),
  doctor: resultOutput(doctorCliOutput),
  apps: ({ input, result }) =>
    appsCliOutput({
      result: result as Parameters<typeof appsCliOutput>[0]['result'],
      appsFilter: input.appsFilter as Parameters<typeof appsCliOutput>[0]['appsFilter'],
    }),
  session: resultOutput(sessionCliOutput),
  artifacts: resultOutput(artifactsCliOutput),
  open: resultOutput(openCliOutput),
  close: resultOutput(closeCliOutput),
  install: resultOutput(deployCliOutput),
  reinstall: resultOutput(deployCliOutput),
  'install-from-source': resultOutput(installFromSourceCliOutput),
  prepare: messageOutput,
  viewport: messageOutput,
} as const satisfies Record<string, CliOutputFormatter>;

function formatDeviceLine(device: AgentDeviceDevice): string {
  const kind = device.kind ? ` ${device.kind}` : '';
  const target = device.target ? ` target=${device.target}` : '';
  const booted = typeof device.booted === 'boolean' ? ` booted=${device.booted}` : '';
  return `${device.name} (${device.platform}${kind}${target})${booted}`;
}

function formatCloudArtifactLine(artifact: CloudArtifactsResult['cloudArtifacts'][number]): string {
  const url = artifact.url ? ` ${artifact.url}` : '';
  const availability = artifact.availability ? ` ${artifact.availability}` : '';
  return `${artifact.kind}: ${artifact.name}${availability}${url}`;
}

function formatDaemonArtifactLine(artifact: DaemonArtifactsResult['artifacts'][number]): string {
  return `${artifact.filename}: ${artifact.mimeType} ${artifact.sizeBytes} bytes id=${artifact.id}`;
}

function formatCloudArtifactsRetryCommand(result: CloudArtifactsResult): string | undefined {
  if (!result.providerSessionId) return undefined;
  return `agent-device artifacts ${result.providerSessionId} --provider ${result.provider} --json`;
}

function readDoctorChecks(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (check): check is Record<string, unknown> =>
          Boolean(check) && typeof check === 'object' && !Array.isArray(check),
      )
    : [];
}
