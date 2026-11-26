import fs from 'node:fs';
import type { DaemonTransport } from '@agent-device/daemon-client';
import type { CliFlags } from '@agent-device/contracts/command';
import { openVerifiedFileForRead } from '@agent-device/host-kit/file';
import { registerDiagnosticSensitiveValue } from '@agent-device/host-kit/diagnostics';
import { AppError, type ReasonTable } from '@agent-device/kernel/errors';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type {
  CloudSessionBinding,
  RemoteConnectionState,
} from '@agent-device/remote/remote-connection-state';
import { isLegacyCloudProfile } from './active-connection.ts';
import { parseCloudAttachment, type CloudAttachment } from './cloud-attachment-schema.ts';
import {
  admitCloudCredentialDirectory,
  CLOUD_CONNECTION_REASONS,
  assertCloudCredentialFile,
  cloudAttachmentPath,
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
    const fd = admitCloudCredentialDirectory(location)
      ? openVerifiedFileForRead(cloudAttachmentPath(location))
      : undefined;
    if (fd !== undefined) {
      try {
        assertCloudCredentialFile(fs.fstatSync(fd));
        attachment = parseCloudAttachment(JSON.parse(fs.readFileSync(fd, 'utf8')));
      } finally {
        fs.closeSync(fd);
      }
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
  registerDiagnosticSensitiveValue(attachment.daemonAuthToken);
  registerDiagnosticSensitiveValue(attachment.daemonBaseUrl);
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
  return await withCloudConnectionOwner(location, session.generation, () =>
    bindAttachmentFlags(options),
  );
}

function bindAttachmentFlags(options: CloudAttachmentOptions): {
  host: HostEnvironment;
  flags: CliFlags;
} {
  const attachment = resolveCloudAttachment(options.location, options.session);
  const env = { ...options.host.env };
  delete env.AGENT_DEVICE_DAEMON_BASE_URL;
  delete env.AGENT_DEVICE_DAEMON_AUTH_TOKEN;
  delete env.AGENT_DEVICE_DAEMON_TRANSPORT;
  delete env.AGENT_DEVICE_DAEMON_SERVER_MODE;
  return {
    host: { ...options.host, env },
    flags: {
      ...options.flags,
      remoteConfig: undefined,
      daemonBaseUrl: attachment.daemonBaseUrl,
      daemonAuthToken: attachment.daemonAuthToken,
      daemonTransport: 'http',
      tenant: undefined,
      runId: undefined,
      sessionIsolation: undefined,
      leaseId: undefined,
      leaseBackend: undefined,
    },
  };
}

export async function protectConnectionTransport(
  context: {
    command: string;
    effectiveFlags: Pick<CliFlags, 'daemonAuthToken'>;
    cloudSession?: CloudSessionBinding;
    claimedConnection?: RemoteConnectionState | null;
    daemonPaths: { baseDir: string };
  },
  transport: DaemonTransport,
): Promise<DaemonTransport> {
  const token = context.effectiveFlags.daemonAuthToken;
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
