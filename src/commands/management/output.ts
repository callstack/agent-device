import type {
  AgentDeviceCapabilitiesResult,
  AgentDeviceDevice,
  AgentDeviceSession,
  AppCloseResult,
  AppDeployResult,
  AppInstallFromSourceResult,
  AppOpenResult,
  CommandRequestResult,
  SessionCloseResult,
  SessionSaveScriptResult,
} from '@agent-device/contracts/client';
import type {
  AgentArtifactsResult,
  CloudArtifactsResult,
  DaemonArtifactsResult,
} from '@agent-device/contracts/observability';
import { readCommandMessage } from '@agent-device/kernel/success-text';
import { snapshotCliOutput } from '../capture/output.ts';
import type { CliOutput } from '../command-contract.ts';
import {
  type CliOutputFormatter,
  messageCliOutput,
  messageOutput,
  resultOutput,
} from '../output-common.ts';

async function devicesCliOutput(result: AgentDeviceDevice[]): Promise<CliOutput> {
  const { serializeDevice } = await import('../../daemon/result-serialization.ts');
  const data = { devices: result.map(serializeDevice) };
  return { data, text: result.map(formatDeviceLine).join('\n') };
}

async function capabilitiesCliOutput(result: AgentDeviceCapabilitiesResult): Promise<CliOutput> {
  const { serializeDevice } = await import('../../daemon/result-serialization.ts');
  const data = {
    device: serializeDevice(result.device),
    availableCommands: result.availableCommands,
  };
  return {
    data,
    text: [
      `${formatDeviceLine(result.device)} supports ${result.availableCommands.length} commands:`,
      result.availableCommands.join(' '),
    ].join('\n'),
  };
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
        : 'Showing user-installed apps or deferred provider app assets. Use --all to include system apps on a live device.\n',
    text:
      params.result.length > 0
        ? params.result.join('\n')
        : params.appsFilter === 'all'
          ? 'No apps found.'
          : 'No user apps or provider app assets found.',
  };
}

async function sessionCliOutput(
  result: { sessions: AgentDeviceSession[] } | { stateDir: string } | SessionSaveScriptResult,
): Promise<CliOutput> {
  if ('savedScript' in result) {
    return {
      data: result,
      text: `Published script: ${result.savedScript}\nSession remains active: ${result.session}\nActions: ${result.actionCount}`,
    };
  }
  if ('stateDir' in result) {
    return { data: result, text: result.stateDir };
  }
  const { serializeSessionListEntry } = await import('../../daemon/result-serialization.ts');
  const data = { sessions: result.sessions.map(serializeSessionListEntry) };
  return { data, text: JSON.stringify(data, null, 2) };
}

export async function openCliOutput(result: AppOpenResult): Promise<CliOutput> {
  const { serializeOpenResult } = await import('../../daemon/result-serialization.ts');
  const data = serializeOpenResult(result);
  const lines = [readCommandMessage(data)].filter((line): line is string => Boolean(line));
  if (typeof data.sessionStateDir === 'string') {
    lines.push(`Session state: ${data.sessionStateDir}`);
  }
  for (const warning of result.warnings ?? []) {
    lines.push(`Warning: ${warning}`);
  }
  // open --foreground: the composed initial snapshot renders through the SAME
  // path `snapshot -i` uses (label dedupe + interactive tree text), after the
  // open confirmation — the one-call promise holds on default stdout, not just
  // --json. The composed capture is interactive-only by construction.
  const snapshotOutput = await buildOpenInitialSnapshotOutput(result.snapshot);
  if (snapshotOutput) {
    data.snapshot = snapshotOutput.jsonData ?? snapshotOutput.data;
    if (snapshotOutput.text) lines.push(snapshotOutput.text);
  }
  return {
    data,
    ...(snapshotOutput?.stderr ? { stderr: snapshotOutput.stderr } : {}),
    text: lines.join('\n') || null,
  };
}

async function buildOpenInitialSnapshotOutput(
  snapshot: AppOpenResult['snapshot'],
): Promise<CliOutput | null> {
  if (!snapshot || !Array.isArray(snapshot.nodes)) return null;
  return await snapshotCliOutput({
    result: snapshot as unknown as Parameters<typeof snapshotCliOutput>[0]['result'],
    interactiveOnly: true,
  });
}

async function closeCliOutput(result: AppCloseResult | SessionCloseResult): Promise<CliOutput> {
  const { serializeCloseResult } = await import('../../daemon/result-serialization.ts');
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

async function deployCliOutput(result: AppDeployResult): Promise<CliOutput> {
  const { serializeDeployResult } = await import('../../daemon/result-serialization.ts');
  return messageCliOutput(serializeDeployResult(result));
}

async function installFromSourceCliOutput(result: AppInstallFromSourceResult): Promise<CliOutput> {
  const { serializeInstallFromSourceResult } = await import('../../daemon/result-serialization.ts');
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

export async function doctorCliOutput(result: CommandRequestResult): Promise<CliOutput> {
  const { consumeDoctorProgressRendered } = await import('../../daemon/client/doctor-progress.ts');
  const { formatDoctorCheckDetailLines, formatDoctorCheckSummaryLine } =
    await import('../../daemon/handlers/doctor-output.ts');
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
  capabilities: resultOutput(capabilitiesCliOutput),
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
  const claimed = device.claimedBy
    ? ` claimed by session "${device.claimedBy.session}" in ${device.claimedBy.workspace}`
    : '';
  return `${device.name} (${device.platform}${kind}${target})${booted}${claimed}`;
}

function formatCloudArtifactLine(artifact: CloudArtifactsResult['cloudArtifacts'][number]): string {
  const url = artifact.url ? ` ${artifact.url}` : '';
  const availability = artifact.availability ? ` ${artifact.availability}` : '';
  return `${artifact.kind}: ${artifact.name}${availability}${url}`;
}

function formatDaemonArtifactLine(artifact: DaemonArtifactsResult['artifacts'][number]): string {
  const type = artifact.artifactType ? ` (${artifact.artifactType})` : '';
  return `${artifact.filename}${type}: ${artifact.mimeType} ${artifact.sizeBytes} bytes id=${artifact.id}`;
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
