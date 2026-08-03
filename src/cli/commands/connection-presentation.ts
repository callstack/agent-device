import { fingerprint, type RemoteConnectionState } from '../../remote/remote-connection-state.ts';
import type { ConnectVerificationFacts } from '../connection/connect-provider-adapters.ts';
import {
  connectionProviderLeaseKind,
  isConnectProviderName,
  type ConnectProvider,
} from '../connection/provider-policy.ts';

export type ConnectReadiness = ConnectVerificationFacts & {
  preparationMessage: string;
  nextSteps: string[];
  notes?: string[];
};

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
      nextSteps: buildConnectWorkflow(state).nextSteps,
      message:
        'No live device session has been created. Run devices to inspect inventory without allocating, then open when ready.',
    };
  }
  if (leaseKind === 'direct-device-provider') {
    return {
      status: 'deferred',
      nextSteps: buildConnectWorkflow(state).nextSteps,
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

export function presentConnectReadiness(
  state: RemoteConnectionState,
  facts: ConnectVerificationFacts,
): ConnectReadiness {
  return {
    ...facts,
    preparationMessage:
      buildLeasePreparationNotice(state)?.message ?? 'No live device session has been created.',
    ...buildConnectWorkflow(state, facts),
  };
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
  if (readiness.app) lines.push(renderApp(state, readiness.app));
  lines.push(readiness.preparationMessage);
  lines.push('Next:');
  lines.push(...readiness.nextSteps.map((step) => `  ${step}`));
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
  const nextSteps = readiness?.nextSteps ?? leasePreparation?.nextSteps ?? [];
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
          ...(readiness.notes ? { notes: readiness.notes } : {}),
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

function renderDevice(device: NonNullable<ConnectReadiness['device']>): string {
  const osVersion = 'osVersion' in device ? device.osVersion : undefined;
  const os = [device.platform, osVersion].filter(Boolean).join(' ');
  const detail = os ? ` (${os})` : '';
  return device.status === 'deferred'
    ? `Device: ${device.name ?? 'Provider-selected device'} — allocated on first device command`
    : `Device: ${device.name ?? device.reference ?? 'Configured device'}${detail} — verified`;
}

function renderApp(
  state: RemoteConnectionState,
  app: NonNullable<ConnectReadiness['app']>,
): string {
  if (app.status === 'missing') {
    return `App: ${missingAppLabel(state)} — ${app.message ?? 'Install or attach an app before open.'}`;
  }
  const label = app.name ?? app.reference ?? 'configured app';
  const suffix = app.status === 'verified' ? 'verified' : (app.message ?? 'configured');
  return `App: ${label} — ${suffix}`;
}

function buildConnectWorkflow(
  state: RemoteConnectionState,
  facts?: ConnectVerificationFacts,
): Pick<ConnectReadiness, 'nextSteps' | 'notes'> {
  const provider = state.leaseProvider;
  return provider && isConnectProviderName(provider)
    ? CONNECT_WORKFLOW_POLICIES[provider](state, facts)
    : openWorkflow(state);
}

type ConnectWorkflowPolicy = (
  state: RemoteConnectionState,
  facts?: ConnectVerificationFacts,
) => Pick<ConnectReadiness, 'nextSteps' | 'notes'>;

const CONNECT_WORKFLOW_POLICIES = {
  cloud: openWorkflow,
  proxy: (state) => ({
    nextSteps: [
      'agent-device devices',
      `agent-device open ${appIdPlaceholder(state.platform)} --relaunch`,
    ],
  }),
  limrun: (state) => {
    const appId = appIdPlaceholder(state.platform);
    return {
      nextSteps: [
        `agent-device install ${appId} <app-path-or-url>`,
        `agent-device open ${appId} --relaunch`,
      ],
    };
  },
  browserstack: (state, facts) => ({
    nextSteps: facts ? openWorkflow(state).nextSteps : defaultDirectProviderLifecycle(),
    notes: providerArtifactNotes(true),
  }),
  'aws-device-farm': awsDeviceFarmWorkflow,
} satisfies Record<ConnectProvider, ConnectWorkflowPolicy>;

function awsDeviceFarmWorkflow(
  state: RemoteConnectionState,
  facts?: ConnectVerificationFacts,
): ReturnType<ConnectWorkflowPolicy> {
  const appMissing = facts?.app?.status === 'missing';
  return {
    nextSteps: facts
      ? [...awsReconnectStep(facts, appMissing), ...openWorkflow(state).nextSteps]
      : defaultDirectProviderLifecycle(),
    notes: providerArtifactNotes(!appMissing),
  };
}

function awsReconnectStep(facts: ConnectVerificationFacts, appMissing: boolean): string[] {
  if (!appMissing || !facts.project?.reference || !facts.device?.reference) return [];
  return [
    `agent-device connect aws-device-farm --platform ${facts.device.platform} --aws-project-arn ${facts.project.reference} --aws-device-arn ${facts.device.reference} --aws-app-arn <arn> --force`,
  ];
}

function providerArtifactNotes(includeAppIdNote: boolean): string[] {
  return [
    ...(includeAppIdNote
      ? ['Use the installed package or bundle identifier in open, not the app artifact name.']
      : []),
    'After close, run agent-device artifacts --json for provider video and logs.',
  ];
}

function openWorkflow(state: RemoteConnectionState): ReturnType<ConnectWorkflowPolicy> {
  return {
    nextSteps: [`agent-device open ${appIdPlaceholder(state.platform)} --relaunch`],
  };
}

function defaultDirectProviderLifecycle(): string[] {
  return [
    'agent-device open <package-or-bundle-id> --relaunch',
    'agent-device snapshot -i',
    'agent-device close',
    'agent-device artifacts --json',
  ];
}

function appIdPlaceholder(platform: RemoteConnectionState['platform']): string {
  return platform === 'ios' ? '<bundle-id>' : '<package-id>';
}

function missingAppLabel(state: RemoteConnectionState): string {
  if (state.leaseProvider === 'aws-device-farm') return 'not attached';
  if (state.leaseProvider === 'limrun') return 'not installed yet';
  return 'not available';
}
