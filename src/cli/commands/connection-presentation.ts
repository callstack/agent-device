import { fingerprint, type RemoteConnectionState } from '../../remote/remote-connection-state.ts';
import type { ConnectReadiness } from '../connection/connect-provider-adapters.ts';
import { connectionProviderLeaseKind } from '../connection/provider-policy.ts';

export type RuntimePreparationNotice = {
  status: 'deferred';
  message: string;
  nextStep: string;
};

export type LeasePreparationNotice = {
  status: 'deferred';
  message: string;
  nextSteps: string[];
};

export function buildLeasePreparationNotice(
  state: RemoteConnectionState,
): LeasePreparationNotice | undefined {
  if (state.leaseId) return undefined;
  const leaseKind = connectionProviderLeaseKind(state.leaseProvider);
  if (leaseKind === 'proxy') {
    return {
      status: 'deferred',
      nextSteps: ['agent-device devices', 'agent-device open <app-id> --relaunch'],
      message:
        'No live device session has been created. Run devices to inspect inventory without allocating, then open when ready.',
    };
  }
  if (leaseKind === 'direct-device-provider') {
    return {
      status: 'deferred',
      nextSteps: defaultDirectProviderNextSteps(state),
      message:
        'No live device session has been created. The first device command shown below will allocate one.',
    };
  }
  const needsPlatform =
    state.platform === undefined && state.leaseBackend === undefined
      ? ' Add --platform ios|android if the profile does not set a platform.'
      : '';
  return {
    status: 'deferred',
    nextSteps: [
      'agent-device install-from-source <artifact-url> --platform ios|android',
      'agent-device open <app-id> --relaunch',
      'agent-device snapshot -i',
      'agent-device devices',
    ],
    message:
      'No live device session has been created. Run a device command when ready to allocate or refresh the lease.' +
      needsPlatform,
  };
}

function buildConnectNextSteps(
  state: RemoteConnectionState,
  readiness?: ConnectReadiness,
): string[] {
  return readiness?.nextSteps ?? buildLeasePreparationNotice(state)?.nextSteps ?? [];
}

export function renderConnectSuccess(options: {
  state: RemoteConnectionState;
  readiness?: ConnectReadiness;
  runtimePreparation?: RuntimePreparationNotice;
}): string {
  const { state, readiness, runtimePreparation } = options;
  if (!readiness) {
    const leasePreparation = buildLeasePreparationNotice(state);
    return [
      `Configured remote session "${state.session}" tenant "${state.tenant}" run "${state.runId}"${state.leaseId ? ` lease ${state.leaseId}` : ''}.`,
      leasePreparation?.message,
      runtimePreparation?.message,
    ]
      .filter((line): line is string => Boolean(line))
      .join('\n');
  }
  const lines = [
    `${readiness.status === 'verified' ? 'Connected' : 'Configured'} successfully with ${readiness.service}.`,
    `${readiness.status === 'verified' ? 'Verified' : 'Status'}: ${readiness.message}`,
  ];
  if (readiness.project) {
    lines.push(`Project: ${readiness.project.name ?? readiness.project.reference} — verified`);
  }
  if (readiness.device) lines.push(renderDevice(readiness.device));
  if (readiness.app) lines.push(renderApp(readiness.app));
  lines.push('No live device session has been created.');
  lines.push('Next:');
  lines.push(...buildConnectNextSteps(state, readiness).map((step) => `  ${step}`));
  lines.push(...(readiness.notes ?? []));
  if (runtimePreparation) lines.push(runtimePreparation.message);
  return lines.join('\n');
}

export function serializeConnectionState(options: {
  state: RemoteConnectionState;
  runtimePreparation?: RuntimePreparationNotice;
  readiness?: ConnectReadiness;
}): Record<string, unknown> {
  const { state, runtimePreparation, readiness } = options;
  const leasePreparation = buildLeasePreparationNotice(state);
  const nextSteps = buildConnectNextSteps(state, readiness);
  return {
    connected: true,
    session: state.session,
    tenant: state.tenant,
    runId: state.runId,
    leaseAllocated: Boolean(state.leaseId),
    leaseId: state.leaseId,
    leaseBackend: state.leaseBackend,
    leaseProvider: state.leaseProvider,
    platform: state.platform,
    target: state.target,
    remoteConfig: state.remoteConfigPath,
    remoteConfigHash: state.remoteConfigHash,
    daemonBaseUrlFingerprint: fingerprint(state.daemon?.baseUrl),
    liveSession: {
      status: state.leaseId ? 'created' : 'not-created',
      ...(state.leaseId ? { leaseId: state.leaseId } : {}),
    },
    ...(readiness
      ? {
          verification: {
            status: readiness.status,
            service: readiness.service,
            message: readiness.message,
            ...(readiness.project ? { project: readiness.project } : {}),
          },
          ...(readiness.device ? { device: readiness.device } : {}),
          ...(readiness.app ? { app: readiness.app } : {}),
          nextSteps,
        }
      : {}),
    metro: state.metro
      ? { prepared: true, projectRoot: state.metro.projectRoot }
      : { prepared: false },
    ...(leasePreparation ? { leasePreparation } : {}),
    ...(runtimePreparation ? { runtimePreparation } : {}),
    connectedAt: state.connectedAt,
    updatedAt: state.updatedAt,
  };
}

function defaultDirectProviderNextSteps(state: RemoteConnectionState): string[] {
  if (state.leaseProvider === 'limrun') {
    const appId = state.platform === 'ios' ? '<bundle-id>' : '<package-id>';
    return [
      `agent-device install ${appId} <app-path-or-url>`,
      `agent-device open ${appId} --relaunch`,
    ];
  }
  return [
    'agent-device open <package-or-bundle-id> --relaunch',
    'agent-device snapshot -i',
    'agent-device close',
    'agent-device artifacts --json',
  ];
}

function renderDevice(device: NonNullable<ConnectReadiness['device']>): string {
  const osVersion = 'osVersion' in device ? device.osVersion : undefined;
  const os = [device.platform, osVersion].filter(Boolean).join(' ');
  const detail = os ? ` (${os})` : '';
  return device.status === 'deferred'
    ? `Device: ${device.name ?? 'Provider-selected device'} — allocated on first device command`
    : `Device: ${device.name ?? device.reference ?? 'Configured device'}${detail} — verified`;
}

function renderApp(app: NonNullable<ConnectReadiness['app']>): string {
  if (app.status === 'missing') {
    return `App: ${app.name ?? 'not available'} — ${app.message ?? 'Install or attach an app before open.'}`;
  }
  const label = app.name ?? app.reference ?? 'configured app';
  const suffix = app.status === 'verified' ? 'verified' : (app.message ?? 'configured');
  return `App: ${label} — ${suffix}`;
}
