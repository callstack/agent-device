import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { DaemonTransport } from '@agent-device/daemon-client';
import type { CliFlags } from '@agent-device/contracts/command';
import { registerDiagnosticSensitiveValue } from '@agent-device/host-kit/diagnostics';
import { AppError, type ReasonTable } from '@agent-device/kernel/errors';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type {
  CloudSessionBinding,
  RemoteConnectionState,
} from '@agent-device/remote/remote-connection-state';
import type { HostedConnectionLease } from '../commands/connection-lease-policy.ts';
import { isLegacyCloudProfile } from './active-connection.ts';
import { cloudLimrunDaemonDir, cloudLimrunEnv, requireHostedLimrunPlugin } from './cloud-limrun.ts';
import { parseCloudAttachment, type CloudAttachment } from './cloud-attachment-schema.ts';
import {
  admitCloudCredentialDirectory,
  CLOUD_CONNECTION_REASONS,
  cloudAttachmentPath,
  readCloudCredentialJson,
  cloudConnectionUnavailable,
  readCurrentCloudConnection,
  writeCloudConnection,
  withCloudConnectionOwner,
  type ConnectionLocation,
} from './cloud-connection-record.ts';

const CLOUD_ATTACHMENT_REASONS = {
  // The saved session attachment is missing, invalid, or for a different transport.
  unavailable: { reason: 'cloud_attachment_unavailable' },
} as const satisfies ReasonTable<'cloud sessions'>;

export function writeCloudAttachment(
  location: ConnectionLocation,
  attachment: CloudAttachment,
): void {
  // The pending record makes a partial write unreadable to commands. Write directly so recovery
  // has only one credential file to remove, even if the writer dies mid-write.
  admitCloudCredentialDirectory(location, true);
  fs.writeFileSync(cloudAttachmentPath(location), JSON.stringify(attachment), {
    flag: 'wx',
    mode: 0o600,
  });
}

function resolveCloudAttachment(
  location: ConnectionLocation,
  session: CloudSessionBinding,
): CloudAttachment {
  let attachment: CloudAttachment | undefined;
  try {
    if (admitCloudCredentialDirectory(location)) {
      attachment = parseCloudAttachment(readCloudCredentialJson(cloudAttachmentPath(location)));
    }
  } catch (error) {
    if (
      error instanceof AppError &&
      error.details?.reason === CLOUD_CONNECTION_REASONS.credentialStoreUnsafe.reason
    )
      throw error;
    // Handle a missing or invalid attachment with the same recovery command.
  }
  if (attachment?.kind !== session.transport) {
    throw new AppError('COMMAND_FAILED', 'Cloud session attachment is unavailable.', {
      reason: CLOUD_ATTACHMENT_REASONS.unavailable.reason,
      hint: 'Run agent-device disconnect in this session, then reconnect.',
    });
  }
  if (attachment.kind === 'agent-device-daemon') {
    registerDiagnosticSensitiveValue(attachment.daemonAuthToken);
    registerDiagnosticSensitiveValue(attachment.daemonBaseUrl);
  } else {
    registerDiagnosticSensitiveValue(attachment.token);
    registerDiagnosticSensitiveValue(attachment.apiUrl);
    if (attachment.platform === 'android') {
      registerDiagnosticSensitiveValue(attachment.adbWebSocketUrl);
    }
  }
  return attachment;
}

type CloudAttachmentOptions = {
  host: HostEnvironment;
  flags: CliFlags;
  location: ConnectionLocation;
  session: CloudSessionBinding;
};

export async function bindCloudAttachment(options: CloudAttachmentOptions) {
  const { location, session } = options;
  if (session.transport === 'limrun') await requireHostedLimrunPlugin(options.host.env);
  return await withCloudConnectionOwner(location, session.generation, () =>
    bindAttachmentFlags(options),
  );
}

function bindAttachmentFlags(options: CloudAttachmentOptions): {
  host: HostEnvironment;
  flags: CliFlags;
  token: string;
  daemonStateDir?: string;
  hostedLease?: HostedConnectionLease;
  /** A proxy front keeps the connection's lease scope, so its commands carry the lease. */
  proxyFront: boolean;
} {
  const attachment = resolveCloudAttachment(options.location, options.session);
  const env = { ...options.host.env };
  delete env.AGENT_DEVICE_DAEMON_BASE_URL;
  delete env.AGENT_DEVICE_DAEMON_AUTH_TOKEN;
  delete env.AGENT_DEVICE_DAEMON_TRANSPORT;
  delete env.AGENT_DEVICE_DAEMON_SERVER_MODE;
  if (attachment.kind === 'limrun') {
    delete env.AGENT_DEVICE_CLOUD_API_KEY;
    delete env.AGENT_DEVICE_CLOUD_API_KEY_ORIGIN;
    const { location, session } = options;
    const { record } = readCurrentCloudConnection(location, session.generation);
    const hostedLeaseId = record.hostedLeaseId ?? randomBytes(16).toString('hex');
    if (record.hostedLeaseId === undefined)
      writeCloudConnection(location, { ...record, hostedLeaseId });
    return {
      host: {
        ...options.host,
        env: {
          ...env,
          ...cloudLimrunEnv(),
          LIMRUN_HOSTED_ATTACHMENT_DEADLINE: undefined,
          AGENT_DEVICE_HOSTED_ATTACHMENT: JSON.stringify({
            ...location,
            generation: session.generation,
          }),
        },
      },
      flags: {
        ...options.flags,
        daemonBaseUrl: undefined,
        daemonAuthToken: undefined,
        daemonTransport: 'auto',
        daemonServerMode: undefined,
      },
      token: attachment.token,
      daemonStateDir: cloudLimrunDaemonDir(location, session),
      hostedLease: {
        id: hostedLeaseId,
        replaceSettled: (id) => replaceHostedLeaseId(location, session.generation, id),
      },
      proxyFront: false,
    };
  }
  const proxyFront = attachment.leasing === 'proxy-front';
  return {
    host: { ...options.host, env },
    token: attachment.daemonAuthToken,
    proxyFront,
    flags: {
      ...options.flags,
      remoteConfig: undefined,
      daemonBaseUrl: attachment.daemonBaseUrl,
      daemonAuthToken: attachment.daemonAuthToken,
      daemonTransport: 'http',
      ...(proxyFront
        ? {}
        : {
            tenant: undefined,
            runId: undefined,
            sessionIsolation: undefined,
            leaseId: undefined,
            leaseBackend: undefined,
          }),
    },
  };
}

async function replaceHostedLeaseId(
  location: ConnectionLocation,
  generation: string,
  settledId: string,
): Promise<string> {
  return await withCloudConnectionOwner(location, generation, () => {
    const { record } = readCurrentCloudConnection(location, generation);
    const currentId = record.hostedLeaseId;
    if (!currentId) throw cloudConnectionUnavailable(CLOUD_CONNECTION_REASONS.changed.reason);
    if (currentId !== settledId) return currentId;
    const hostedLeaseId = randomBytes(16).toString('hex');
    writeCloudConnection(location, { ...record, hostedLeaseId });
    return hostedLeaseId;
  });
}

export function bindHostedDaemon(host: HostEnvironment, daemonStateDir: string) {
  const refuse = () => cloudConnectionUnavailable(CLOUD_CONNECTION_REASONS.changed.reason);
  let launch: Partial<ConnectionLocation & { generation: string }> | null;
  try {
    launch = JSON.parse(host.env.AGENT_DEVICE_HOSTED_ATTACHMENT ?? 'null');
  } catch {
    throw refuse();
  }
  const { stateDir, session, generation } = launch ?? {};
  if (
    typeof stateDir !== 'string' ||
    typeof session !== 'string' ||
    typeof generation !== 'string' ||
    cloudLimrunDaemonDir({ stateDir, session }, { generation }) !== daemonStateDir
  )
    throw refuse();
  const location = { stateDir, session };
  const { record, state, binding } = readCurrentCloudConnection(location, generation);
  if (!record.hostedLeaseId || !state.leaseBackend || binding.transport !== 'limrun')
    throw refuse();
  const attachment = resolveCloudAttachment(location, binding);
  if (attachment.kind !== 'limrun') throw refuse();
  const assertCurrent = () => {
    const current = readCurrentCloudConnection(location, generation).record.hostedLeaseId;
    if (!current) throw refuse();
    return current;
  };
  assertCurrent();
  return {
    host: {
      ...host,
      env: {
        ...host.env,
        ...cloudLimrunEnv(attachment),
        AGENT_DEVICE_HOSTED_ATTACHMENT: undefined,
        LIMRUN_HOSTED_ATTACHMENT_DEADLINE: binding.deadlineAt,
      },
    },
    assertCurrent,
    session,
    generation,
    lease: {
      leaseId: record.hostedLeaseId,
      tenantId: state.tenant,
      runId: state.runId,
      backend: state.leaseBackend,
      leaseProvider: state.leaseProvider,
      deviceKey: state.deviceKey,
      clientId: state.clientId,
    },
  };
}

export async function protectConnectionTransport(
  context: {
    command: string;
    effectiveFlags: Pick<CliFlags, 'daemonAuthToken'>;
    cloudSession?: CloudSessionBinding;
    cloudAttachmentToken?: string;
    claimedConnection?: RemoteConnectionState | null;
    daemonPaths: { baseDir: string };
  },
  transport: DaemonTransport,
): Promise<DaemonTransport> {
  const token = context.cloudAttachmentToken ?? context.effectiveFlags.daemonAuthToken;
  if (!token || (!context.cloudSession && !isLegacyDisconnect(context))) return transport;
  const { containsCloudCredential } = await import('../cloud-response.ts');
  const { normalizeError } = await import('@agent-device/kernel/errors');
  const safe = (value: unknown) => !containsCloudCredential(value, [token]);
  const rejectEcho = () =>
    new AppError('COMMAND_FAILED', 'The hosted daemon returned an invalid response.');
  return async (request, options) => {
    const onProgress = options?.onProgress;
    const response = await transport(request, {
      ...options,
      skipRemoteDiagnostics: true,
      onProgress:
        onProgress &&
        ((event) => {
          if (safe(event)) onProgress(event);
        }),
    }).catch((error: unknown) => {
      if (!safe(normalizeError(error))) throw rejectEcho();
      throw error;
    });
    if (!safe(response)) throw rejectEcho();
    return response;
  };
}

function isLegacyDisconnect(context: Parameters<typeof protectConnectionTransport>[0]): boolean {
  return (
    context.command === 'disconnect' &&
    isLegacyCloudProfile(context.daemonPaths.baseDir, context.claimedConnection?.remoteConfigPath)
  );
}
