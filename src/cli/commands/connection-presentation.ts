import { fingerprint, type RemoteConnectionState } from '../../remote/remote-connection-state.ts';
import type { ConnectVerification } from '../connection/connect-provider-adapters.ts';
import { connectionProviderLeaseKind } from '../connection/provider-policy.ts';
import { shellQuoteIfNeeded } from '../../utils/shell-quote.ts';

export type ConnectReadiness = ConnectVerification & {
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

export type PreviousLeaseReleaseNotice = {
  status: 'unreleased';
  message: string;
};

export function buildLeasePreparationNotice(
  state: RemoteConnectionState,
  verification?: ConnectVerification,
): LeasePreparationNotice | undefined {
  if (state.leaseId) return undefined;
  const leaseKind = connectionProviderLeaseKind(state.leaseProvider);
  if (leaseKind === 'proxy') {
    return {
      status: 'deferred',
      nextSteps: buildConnectWorkflow(state, verification).nextSteps,
      message:
        'No live device session has been created. Run devices to inspect inventory without allocating, then open when ready.',
    };
  }
  if (leaseKind === 'direct-device-provider') {
    return {
      status: 'deferred',
      nextSteps: buildConnectWorkflow(state, verification).nextSteps,
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
    nextSteps: scopeNextSteps(state, [
      'agent-device install-from-source <artifact-url> --platform ios|android',
      'agent-device open <app-id> --relaunch',
      'agent-device snapshot -i',
      'agent-device devices',
    ]),
    message:
      'No live device session has been created. Run a device command when ready to allocate or refresh the lease.' +
      needsPlatform,
  };
}

export function presentConnectReadiness(
  state: RemoteConnectionState,
  verification: ConnectVerification,
): ConnectReadiness {
  return {
    ...verification,
    preparationMessage:
      buildLeasePreparationNotice(state, verification)?.message ??
      'No live device session has been created.',
    ...buildConnectWorkflow(state, verification),
  };
}

export function renderConnectSuccess(options: {
  state: RemoteConnectionState;
  readiness?: ConnectReadiness;
  runtimePreparation?: RuntimePreparationNotice;
  previousLeaseNotice?: PreviousLeaseReleaseNotice;
}): string {
  const { state, readiness, runtimePreparation, previousLeaseNotice } = options;
  if (!readiness) {
    const leasePreparation = buildLeasePreparationNotice(state);
    return [
      `Configured remote session "${state.session}" tenant "${state.tenant}" run "${state.runId}"${state.leaseId ? ` lease ${state.leaseId}` : ''}.`,
      leasePreparation?.message,
      runtimePreparation?.message,
      previousLeaseNotice?.message,
    ]
      .filter((line): line is string => Boolean(line))
      .join('\n');
  }
  const status = connectionVerificationStatus(readiness);
  const lines = [
    `${status === 'verified' ? 'Connected' : 'Configured'} successfully with ${readiness.service}.`,
    `${status === 'verified' ? 'Verified' : 'Status'}: ${readiness.verificationMessage}`,
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
  if (previousLeaseNotice) lines.push(previousLeaseNotice.message);
  return lines.join('\n');
}

export function serializeConnectionState(options: {
  state: RemoteConnectionState;
  runtimePreparation?: RuntimePreparationNotice;
  readiness?: ConnectReadiness;
  previousLeaseNotice?: PreviousLeaseReleaseNotice;
}): Record<string, unknown> {
  const { state, runtimePreparation, readiness, previousLeaseNotice } = options;
  const leasePreparation = buildLeasePreparationNotice(state, readiness);
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
    liveSession: buildLiveSessionField(state),
    ...buildReadinessFields(readiness, leasePreparation),
    metro: state.metro
      ? { prepared: true, projectRoot: state.metro.projectRoot }
      : { prepared: false },
    ...buildConnectionNoticeFields({ leasePreparation, runtimePreparation, previousLeaseNotice }),
    connectedAt: state.connectedAt,
    updatedAt: state.updatedAt,
  };
}

function buildLiveSessionField(state: RemoteConnectionState): Record<string, unknown> {
  return {
    status: state.leaseId ? 'created' : 'not-created',
    ...(state.leaseId ? { leaseId: state.leaseId } : {}),
  };
}

function buildReadinessFields(
  readiness: ConnectReadiness | undefined,
  leasePreparation: LeasePreparationNotice | undefined,
): Record<string, unknown> {
  if (!readiness) return {};
  return {
    verification: {
      status: connectionVerificationStatus(readiness),
      service: readiness.service,
      message: readiness.verificationMessage,
      ...(readiness.project ? { project: readiness.project } : {}),
    },
    ...(readiness.device ? { device: readiness.device } : {}),
    ...(readiness.app ? { app: readiness.app } : {}),
    nextSteps: readiness.nextSteps ?? leasePreparation?.nextSteps ?? [],
    ...(readiness.notes ? { notes: readiness.notes } : {}),
  };
}

function buildConnectionNoticeFields(options: {
  leasePreparation?: LeasePreparationNotice;
  runtimePreparation?: RuntimePreparationNotice;
  previousLeaseNotice?: PreviousLeaseReleaseNotice;
}): Record<string, unknown> {
  const { leasePreparation, runtimePreparation, previousLeaseNotice } = options;
  return {
    ...(leasePreparation ? { leasePreparation } : {}),
    ...(runtimePreparation ? { runtimePreparation } : {}),
    ...(previousLeaseNotice ? { previousLeaseNotice } : {}),
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
  verification?: ConnectVerification,
): Pick<ConnectReadiness, 'nextSteps' | 'notes'> {
  const workflow = buildUnscopedConnectWorkflow(state, verification);
  return { ...workflow, nextSteps: scopeNextSteps(state, workflow.nextSteps) };
}

function buildUnscopedConnectWorkflow(
  state: RemoteConnectionState,
  verification?: ConnectVerification,
): Pick<ConnectReadiness, 'nextSteps' | 'notes'> {
  const leaseKind = connectionProviderLeaseKind(state.leaseProvider);
  if (leaseKind === 'proxy') {
    return {
      nextSteps: [
        'agent-device devices',
        `agent-device open ${appIdPlaceholder(state.platform)} --relaunch`,
      ],
    };
  }
  if (!verification && leaseKind === 'direct-device-provider') {
    return { nextSteps: defaultDirectProviderLifecycle() };
  }
  const appMissing = verification?.app?.status === 'missing';
  return {
    nextSteps: requiresInstall(verification)
      ? installThenOpenWorkflow(state)
      : [...missingAttachedAppRecovery(verification), ...openWorkflow(state).nextSteps],
    ...(supportsProviderArtifacts(verification)
      ? { notes: providerArtifactNotes(state, !appMissing) }
      : {}),
  };
}

function requiresInstall(verification?: ConnectVerification): boolean {
  return verification?.app?.status === 'missing' && verification.device?.status === 'deferred';
}

function supportsProviderArtifacts(verification?: ConnectVerification): boolean {
  return verification?.provider === 'browserstack' || verification?.provider === 'aws-device-farm';
}

function missingAttachedAppRecovery(verification?: ConnectVerification): string[] {
  if (
    verification?.app?.status !== 'missing' ||
    !verification.project?.reference ||
    !verification.device?.reference
  ) {
    return [];
  }
  return [
    `agent-device connect aws-device-farm --platform ${verification.device.platform} --aws-project-arn ${verification.project.reference} --aws-device-arn ${verification.device.reference} --aws-app-arn <arn> --force`,
  ];
}

function providerArtifactNotes(state: RemoteConnectionState, includeAppIdNote: boolean): string[] {
  return [
    ...(includeAppIdNote
      ? ['Use the installed package or bundle identifier in open, not the app artifact name.']
      : []),
    // Notes carry runnable commands too, so they need the same session scoping as
    // nextSteps: an unscoped artifacts call adopts the host-global active connection
    // and can hand back another concurrent job's provider video and logs.
    `After close, run ${scopeCommand(state, 'agent-device artifacts --json')} for provider video and logs.`,
  ];
}

function openWorkflow(state: RemoteConnectionState): Pick<ConnectReadiness, 'nextSteps'> {
  return {
    nextSteps: [`agent-device open ${appIdPlaceholder(state.platform)} --relaunch`],
  };
}

function installThenOpenWorkflow(state: RemoteConnectionState): string[] {
  const appId = appIdPlaceholder(state.platform);
  return [
    `agent-device install ${appId} <app-path-or-url>`,
    `agent-device open ${appId} --relaunch`,
  ];
}

function connectionVerificationStatus(
  verification: ConnectVerification,
): 'verified' | 'configured' {
  return 'status' in verification ? verification.status : 'verified';
}

function defaultDirectProviderLifecycle(): string[] {
  return [
    'agent-device open <package-or-bundle-id> --relaunch',
    'agent-device snapshot -i',
    'agent-device close',
    'agent-device artifacts --json',
  ];
}

function scopeNextSteps(state: RemoteConnectionState, commands: readonly string[]): string[] {
  return commands.map((command) => scopeCommand(state, command));
}

/**
 * The single place a suggested command is bound to the connection it came from.
 * Every command-bearing output — nextSteps, notes, deferred-runtime notices —
 * goes through here so no emitted instruction can resolve against whichever
 * connection happens to be host-global active when the operator runs it.
 */
export function scopeCommand(
  state: Pick<RemoteConnectionState, 'session'>,
  command: string,
): string {
  return `${command} --session ${shellQuoteIfNeeded(state.session)}`;
}

function appIdPlaceholder(platform: RemoteConnectionState['platform']): string {
  return platform === 'ios' ? '<bundle-id>' : '<package-id>';
}

function missingAppLabel(state: RemoteConnectionState): string {
  if (state.leaseProvider === 'aws-device-farm') return 'not attached';
  if (state.leaseProvider === 'limrun') return 'not installed yet';
  return 'not available';
}
