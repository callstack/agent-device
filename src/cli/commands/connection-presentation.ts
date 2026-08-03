import { fingerprint, type RemoteConnectionState } from '../../remote/remote-connection-state.ts';
import type { DirectProviderConnectionVerification } from '../connection/direct-provider-verification.ts';
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
  verification?: DirectProviderConnectionVerification,
): string[] {
  if (!verification) return buildLeasePreparationNotice(state)?.nextSteps ?? [];
  if (verification.provider === 'limrun') return limrunNextSteps(verification);
  if (verification.provider === 'aws-device-farm') return awsNextSteps(verification);
  return [openNextStep(verification.device.platform)];
}

function limrunNextSteps(
  verification: Extract<DirectProviderConnectionVerification, { provider: 'limrun' }>,
): string[] {
  const appId = appIdPlaceholder(verification.device.platform);
  return [
    `agent-device install ${appId} <app-path-or-url>`,
    `agent-device open ${appId} --relaunch`,
  ];
}

function awsNextSteps(
  verification: Extract<DirectProviderConnectionVerification, { provider: 'aws-device-farm' }>,
): string[] {
  if (verification.app.status !== 'missing') {
    return [openNextStep(verification.device.platform)];
  }
  return [
    `agent-device connect aws-device-farm --platform ${verification.device.platform} --aws-project-arn ${verification.project.reference} --aws-device-arn ${verification.device.reference} --aws-app-arn <arn> --force`,
    openNextStep(verification.device.platform),
  ];
}

function openNextStep(platform: 'android' | 'ios' | undefined): string {
  return `agent-device open ${appIdPlaceholder(platform)} --relaunch`;
}

function appIdPlaceholder(platform: 'android' | 'ios' | undefined): string {
  return platform === 'ios' ? '<bundle-id>' : '<package-id>';
}

export function renderConnectSuccess(options: {
  state: RemoteConnectionState;
  verification?: DirectProviderConnectionVerification;
  runtimePreparation?: RuntimePreparationNotice;
}): string {
  const { state, verification, runtimePreparation } = options;
  if (!verification) {
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
    `Connected successfully with ${verification.service}.`,
    `Verified: ${verification.verificationMessage}`,
  ];
  if ('project' in verification && verification.project) {
    lines.push(
      `Project: ${verification.project.name ?? verification.project.reference} — verified`,
    );
  }
  lines.push(renderDevice(verification.device));
  lines.push(renderApp(verification));
  lines.push('No live device session has been created.');
  lines.push('Next:');
  lines.push(...buildConnectNextSteps(state, verification).map((step) => `  ${step}`));
  if (verification.app.status !== 'missing') {
    lines.push(
      'Use the installed package or bundle identifier in open, not the app artifact name.',
    );
  }
  if (verification.provider !== 'limrun') {
    lines.push('After close, run agent-device artifacts --json for provider video and logs.');
  }
  if (runtimePreparation) lines.push(runtimePreparation.message);
  return lines.join('\n');
}

export function serializeConnectionState(options: {
  state: RemoteConnectionState;
  runtimePreparation?: RuntimePreparationNotice;
  verification?: DirectProviderConnectionVerification;
}): Record<string, unknown> {
  const { state, runtimePreparation, verification } = options;
  const leasePreparation = buildLeasePreparationNotice(state);
  const nextSteps = buildConnectNextSteps(state, verification);
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
    ...(verification
      ? {
          verification: {
            status: 'verified',
            service: verification.service,
            message: verification.verificationMessage,
            ...('project' in verification && verification.project
              ? { project: verification.project }
              : {}),
          },
          device: verification.device,
          app: verification.app,
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

function renderDevice(device: DirectProviderConnectionVerification['device']): string {
  const osVersion = 'osVersion' in device ? device.osVersion : undefined;
  const os = [device.platform, osVersion].filter(Boolean).join(' ');
  const detail = os ? ` (${os})` : '';
  return device.status === 'deferred'
    ? `Device: ${device.name ?? 'Provider-selected device'} — allocated on first device command`
    : `Device: ${device.name ?? device.reference ?? 'Configured device'}${detail} — verified`;
}

function renderApp(verification: DirectProviderConnectionVerification): string {
  const app = verification.app;
  if (app.status === 'missing') {
    const state =
      verification.provider === 'aws-device-farm' ? 'not attached' : 'not installed yet';
    return `App: ${state} — ${app.message ?? 'Install or attach an app before open.'}`;
  }
  const label = app.name ?? app.reference ?? 'configured app';
  const suffix = app.status === 'verified' ? 'verified' : (app.message ?? 'configured');
  return `App: ${label} — ${suffix}`;
}
